import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { matches, runAction } from "./actions";
import {
  type Config,
  due,
  inWorkHours,
  loadConfig,
  type Priority,
  rank,
  sourceEntries,
  sourceIds,
} from "./config";
import {
  changes,
  digest,
  due as dueFollowups,
  type Evidence,
  type Followups,
  ledgerPath,
  remind,
  save as saveFollowups,
  stillOpen,
  track,
  update as updateFollowups,
} from "./followups";
import { floorOf, toItems } from "./items";
import { clip, joinSummary, triage, type Triage } from "./llm";
import { notify, tellArgv } from "./notify";
import {
  advance,
  type CollectCtx,
  type Cursors,
  latest,
  prune,
  readState,
  type Signal,
  sourceId,
  unseen,
  type Windows,
  writeState,
} from "./signal";
import { collectAirQuality } from "./sources/airquality";
import { collectDependabot } from "./sources/dependabot";
import { collectEarthquake } from "./sources/earthquake";
import { collectFeed } from "./sources/feed";
import { collectGithub } from "./sources/github";
import { collectHackernews } from "./sources/hackernews";
import { collectJira } from "./sources/jira";
import { collectKev } from "./sources/kev";
import { collectLinear } from "./sources/linear";
import { collectSlack, openServer, type SlackServer } from "./sources/slack";
import { collectTraffic } from "./sources/traffic";
import { collectWeather } from "./sources/weather";
import { syncTodos } from "./todo";
import { verify } from "./verify";

const NOOP = 78; // noon.yaml noop_exit_code: nothing new or nothing worth notifying

/** kind/name source → ISO time of its last handled collection. */
type Collected = Record<string, string>;
/** Per source, the later of two collection times. */
const later = (a: Collected, b: Collected): Collected => {
  const next = { ...a };
  for (const [id, at] of Object.entries(b)) if (!next[id] || at > next[id]) next[id] = at;
  return next;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function main(dryRun: boolean): Promise<number> {
  const root = resolve(import.meta.dir, "..");
  const cfg: Config = loadConfig(root);
  if (sourceIds(cfg).length === 0)
    throw new Error("no sources configured; add one to triage.local.yaml");

  const now = Date.now();
  const afterHours = inWorkHours(cfg.work_hours, new Date(now))
    ? undefined
    : cfg.notify.after_hours_min_priority;
  const minPriority = afterHours ?? cfg.notify.min_priority;
  if (afterHours) console.log(`after hours: holding anything below ${afterHours}`);

  const stateDir = join(root, ".state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // After hours, scanned messages advance separate cursors, so they stay unhandled until the
  // next work-hours run summarizes them.
  const handledPath = join(stateDir, "cursors.json");
  const heldPath = join(stateDir, "after-hours-cursors.json");
  const handled = readState<Cursors>(handledPath);
  const cursors = afterHours ? latest(handled, readState<Cursors>(heldPath)) : handled;
  const cursorsPath = afterHours ? heldPath : handledPath;
  const failures: string[] = [];

  // A work-hours run reaches back to the previous one, so held messages older than max_age count.
  const lastWorkPath = join(stateDir, "last-work-run");
  const lastWork =
    !afterHours && existsSync(lastWorkPath)
      ? Date.parse(readFileSync(lastWorkPath, "utf8")) || Infinity
      : Infinity;
  const from = Math.min(now - cfg.max_age, lastWork);
  const minTs = String(Math.floor(from / 1000));
  const since = new Date(from).toISOString();
  const ctx: CollectCtx = {
    stateDir,
    env: process.env,
    since,
    vips: new Set(Object.keys(cfg.vips)),
  };

  // A scheduled source runs at the first run after each occurrence and reaches back to its last
  // collection. Like cursors, after-hours collections are tracked separately, so the next
  // work-hours run still collects what they held.
  const collectedPath = join(
    stateDir,
    afterHours ? "after-hours-collected.json" : "collected.json",
  );
  const ownCollected = readState<Collected>(collectedPath);
  const lastCollected = afterHours
    ? later(readState<Collected>(join(stateDir, "collected.json")), ownCollected)
    : ownCollected;
  const scheduled = sourceEntries(cfg).flatMap(([id, s]) =>
    s.schedule ? [[id, s.schedule] as const] : [],
  );
  const windows: Windows = {};
  const skipped = new Set<string>();
  for (const [id, schedule] of scheduled) {
    const last = lastCollected[id] ? Date.parse(lastCollected[id]) : undefined;
    if (last !== undefined && last < from) windows[id] = String(Math.floor(last / 1000));
    if (!due(schedule, last, now)) skipped.add(id);
  }
  if (skipped.size) console.log(`not due: ${[...skipped].join(", ")}`);
  const ran = new Set<string>();

  // One slack-mcp-server per source for the whole run: a single Slack session covers both
  // collection and the context pass, instead of re-authenticating between them.
  const servers = new Map<string, SlackServer>();
  let all: Signal[] = [];
  let fresh: Signal[] = [];
  let result: Triage | undefined;
  let collectFailed = false;
  try {
    const { slack, github, linear, jira, weather, traffic, hackernews, feed } = cfg.sources;
    const { earthquake, airquality, dependabot, kev } = cfg.sources;
    const collectors: [string, (ctx: CollectCtx) => Promise<Signal[]>][] = [
      ...Object.entries(slack).map(([name, source]) => [
        `slack/${name}`,
        async (ctx: CollectCtx) => {
          const server = await openServer(name, ctx);
          servers.set(name, server);
          return collectSlack(name, source, ctx, server);
        },
      ]),
      ...Object.entries(github).map(([name, source]) => [
        `github/${name}`,
        (ctx: CollectCtx) => collectGithub(name, source, ctx),
      ]),
      ...Object.keys(linear).map((name) => [
        `linear/${name}`,
        (ctx: CollectCtx) => collectLinear(name, ctx),
      ]),
      ...Object.entries(jira).map(([name, source]) => [
        `jira/${name}`,
        (ctx: CollectCtx) => collectJira(name, source, ctx),
      ]),
      ...Object.entries(weather).map(([name, source]) => [
        `weather/${name}`,
        () => collectWeather(name, source),
      ]),
      ...Object.entries(traffic).map(([name, source]) => [
        `traffic/${name}`,
        (ctx: CollectCtx) => collectTraffic(name, source, ctx),
      ]),
      ...Object.entries(earthquake).map(([name, source]) => [
        `earthquake/${name}`,
        (ctx: CollectCtx) => collectEarthquake(name, source, ctx),
      ]),
      ...Object.entries(airquality).map(([name, source]) => [
        `airquality/${name}`,
        () => collectAirQuality(name, source),
      ]),
      ...Object.entries(dependabot).map(([name, source]) => [
        `dependabot/${name}`,
        (ctx: CollectCtx) => collectDependabot(name, source, ctx),
      ]),
      ...Object.entries(kev).map(([name, source]) => [
        `kev/${name}`,
        () => collectKev(name, source),
      ]),
      ...Object.entries(hackernews).map(([name, source]) => [
        `hackernews/${name}`,
        (ctx: CollectCtx) => collectHackernews(name, source, ctx),
      ]),
      ...Object.entries(feed).map(([name, source]) => [
        `feed/${name}`,
        () => collectFeed(name, source),
      ]),
    ] as [string, (ctx: CollectCtx) => Promise<Signal[]>][];
    const collected = await Promise.all(
      collectors.map(async ([id, collect]) => {
        if (skipped.has(id)) return [];
        const window = windows[id];
        try {
          const signals = await collect(
            window ? { ...ctx, since: new Date(Number(window) * 1000).toISOString() } : ctx,
          );
          ran.add(id);
          return signals;
        } catch (e) {
          failures.push(`source ${id}: ${message(e)}`);
          return [];
        }
      }),
    );
    collectFailed = failures.length > 0;
    all = collected.flat();
    // Each channel's messages stay together in time order, so triage reads them as conversations.
    fresh = unseen(all, cursors, minTs, windows)
      .sort(
        (a, b) =>
          sourceId(a).localeCompare(sourceId(b)) ||
          a.channel.localeCompare(b.channel) ||
          a.time.localeCompare(b.time),
      )
      .map((s) => {
        const floor = floorOf(cfg, s);
        return floor ? { ...s, floor } : s;
      });
    console.log(`${all.length} unread, ${fresh.length} new`);

    if (fresh.length > 0) {
      try {
        result = await triage(root, cfg, fresh, [], afterHours);
        try {
          result = await verify(root, cfg, servers, fresh, result, afterHours);
        } catch (e) {
          failures.push(`context: ${message(e)}`); // the first pass still stands
        }
      } catch (e) {
        failures.push(`llm: ${message(e)}`);
      }
    }
  } finally {
    // Close Slack sessions before actions, which may run long-lived agents.
    await Promise.all([...servers.values()].map((s) => s.close().catch(() => {})));
  }
  if (fresh.length > 0 && !result) {
    for (const f of failures) console.error(f);
    console.error("triage failed; signals stay unhandled for the next run");
    return 1;
  }

  // Follow-ups close on what this run collected. After hours, held items come back in the
  // work-hours summary, which opens and reminds them.
  const evidence: Evidence = {
    ran,
    signals: all,
    now,
    slack: new Map(
      [...servers].map(([name, server]) => {
        const { max_channels, max_messages_per_channel } = cfg.sources.slack[name]!;
        const caps = { maxChannels: max_channels, maxMessages: max_messages_per_channel };
        return [name, { mine: server.me.mine, ...caps }];
      }),
    ),
  };
  const ledgerFile = ledgerPath(root);
  const ledgerBefore = readState<Followups>(ledgerFile);
  let ledger: Followups = updateFollowups(ledgerBefore, evidence, cfg.followups);
  const reminders = afterHours
    ? []
    : dueFollowups(ledger, evidence, fresh, cfg.followups.reminders);
  // The digest lists every waiting follow-up at the first work-hours run after each occurrence.
  const lastDigestPath = join(stateDir, "last-digest");
  const lastDigest = existsSync(lastDigestPath)
    ? Date.parse(readFileSync(lastDigestPath, "utf8")) || undefined
    : undefined;
  const { digest: digestAt } = cfg.followups;
  const digesting = !afterHours && digestAt !== false && due(digestAt, lastDigest, now);
  const listed = digesting ? digest(ledger, evidence) : reminders;
  const still = stillOpen(
    listed.map(([, l]) => l),
    now,
  );

  const triaged = result ? toItems(result, fresh) : undefined;
  const items = triaged?.items ?? [];
  const priority = items.reduce<Priority>(
    (p, i) => (rank(i.priority) > rank(p) ? i.priority : p),
    "none",
  );
  if (triaged) {
    console.log(`\n[${priority}] ${triaged.title}\n${triaged.summary}\n`);
    for (const i of items)
      console.log(`- ${i.priority} ${i.category} (${i.signals.length}): ${i.reason}`);
  }
  if (still.length) console.log(`\nstill open:\n${still.map((l) => `- ${l}`).join("\n")}`);

  // After hours, items below the threshold are held for work hours, so their actions wait too.
  const runs = items
    .filter((i) => !afterHours || rank(i.priority) >= rank(afterHours))
    .flatMap((item) =>
      Object.entries(cfg.actions)
        .filter(([, action]) => matches(action, item))
        .map(([name, action]) => ({ name, action, item })),
    );
  const actioned = [...new Set(runs.map((r) => r.name))];

  // Reminders ride along on a notification that goes out anyway; alone they go out quietly
  // unless one was high. A run action always notifies, so it never runs unannounced.
  let notified = false;
  const carrier = !!triaged && (rank(priority) >= rank(minPriority) || actioned.length > 0);
  if (carrier || still.length) {
    const block = `Still open:\n${still.map((l) => `• ${l}`).join("\n")}`;
    const top = reminders[0]?.[1].priority ?? "low";
    const [p, title, body, url] = carrier
      ? [
          priority,
          triaged.title,
          clip(
            [
              triaged.summary,
              actioned.length && `Actions: ${actioned.join(", ")}`,
              still.length && block,
            ]
              .filter(Boolean)
              .join("\n"),
            1024,
          ),
          // Link the newest linkable message of the first top-priority item.
          items.find((i) => i.priority === priority)?.signals.findLast((s) => s.url)?.url,
        ]
      : [
          rank(top) >= rank("high") ? ("high" as const) : ("low" as const),
          clip(`Still open: ${still.length > 1 ? `${still.length} follow-ups` : still[0]}`, 100),
          joinSummary(still),
          listed.find(([, l]) => l.url)?.[1].url,
        ];
    const argv = tellArgv(root, cfg.notify, p, title, body, url);
    if (dryRun) console.log(`\nwould run: ${argv.slice(0, -1).join(" ")} <summary>`);
    else {
      const { delivered, detail } = await notify(argv);
      console.log(`\ntell: ${detail}`);
      if (!delivered) {
        for (const f of failures) console.error(f);
        console.error("notification not delivered; signals stay unhandled for the next run");
        return 1;
      }
      notified = true;
      // A reminder clipped out of the message wasn't delivered, so it stays due.
      const remindable = new Set(reminders.map(([id]) => id));
      const shown = listed.filter(([id], i) => remindable.has(id) && body.includes(still[i]!));
      ledger = remind(
        ledger,
        shown.map(([id]) => id),
        now,
        cfg.work_hours,
        cfg.followups.again,
      );
    }
  }

  if (triaged) {
    for (const { name, action, item } of runs) {
      if (dryRun) console.log(`would run action ${name} for: ${item.reason}`);
      else {
        const err = await runAction(root, name, action, item);
        if (err) failures.push(err);
      }
    }
    if (!dryRun) writeState(cursorsPath, prune(advance(cursors, fresh), minTs, windows));
    if (!afterHours)
      ledger = track(ledger, items, fresh, {
        notified: carrier,
        minPriority,
        now,
        work: cfg.work_hours,
        first: cfg.followups.first,
        signals: all,
      });
  }
  for (const c of changes(ledgerBefore, ledger)) console.log(`follow-up ${c}`);
  const { todo } = cfg.followups;
  if (todo && dryRun) console.log(`would sync follow-ups with ${todo.join(" ")}`);
  else if (todo) ledger = await syncTodos(root, { ...cfg.followups, todo }, ledger, now);
  if (!dryRun) saveFollowups(ledgerFile, ledger);
  if (digesting && dryRun) console.log(`would send the follow-up digest (${listed.length})`);
  else if (digesting) writeFileSync(lastDigestPath, new Date(now).toISOString(), { mode: 0o600 });
  if (!dryRun && scheduled.length) {
    const next: Collected = {};
    for (const [id] of scheduled) {
      const at = ran.has(id) ? new Date(now).toISOString() : ownCollected[id];
      if (at) next[id] = at;
    }
    writeState(collectedPath, next);
  }
  if (!dryRun && !afterHours && !collectFailed)
    writeFileSync(lastWorkPath, new Date(now).toISOString(), { mode: 0o600 });

  for (const f of failures) console.error(f);
  return failures.length > 0 ? 1 : notified ? 0 : NOOP;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== "--dry-run")) {
    console.error("usage: bun src/main.ts [--dry-run]");
    process.exit(2);
  }
  main(args.includes("--dry-run")).then(
    (code) => process.exit(code),
    (e) => {
      console.error(message(e));
      process.exit(1);
    },
  );
}
