import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { matches, runAction } from "./actions";
import { type Config, inWorkHours, loadConfig, type Priority, rank, sourceIds } from "./config";
import { floorOf, raised, toItems } from "./items";
import { type Context, fallback, triage, type Triage } from "./llm";
import { notify, tellArgv } from "./notify";
import {
  advance,
  type CollectCtx,
  compareTs,
  latest,
  prune,
  readCursors,
  type Signal,
  unseen,
  writeCursors,
} from "./signal";
import { collectFeed } from "./sources/feed";
import { collectGithub } from "./sources/github";
import { collectHackernews } from "./sources/hackernews";
import { collectJira } from "./sources/jira";
import { collectLinear } from "./sources/linear";
import { collectSlack, openServer, type SlackServer, slackContext } from "./sources/slack";
import { collectTraffic } from "./sources/traffic";
import { collectWeather } from "./sources/weather";

const NOOP = 78; // noon.yaml noop_exit_code: nothing new or nothing worth notifying
const CONTEXT_ITEMS = 3; // most flagged items per run that get Slack context and a second pass

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Fetches Slack context for the most important items the LLM flagged at or above the notify
 * threshold and triages once more with it; otherwise returns `first`.
 */
async function withContext(
  root: string,
  cfg: Config,
  servers: Map<string, SlackServer>,
  fresh: Signal[],
  first: Triage,
  afterHours?: Priority,
): Promise<Triage> {
  const minPriority = afterHours ?? cfg.notify.min_priority;
  const wanted = first.items
    .map((i) => ({
      ...i,
      priority: raised(
        i.priority,
        i.ids.flatMap((id) => fresh[Number(id.slice(1)) - 1] ?? []),
      ),
    }))
    .filter((i) => i.needs_context && rank(i.priority) >= rank(minPriority))
    .sort((a, b) => rank(b.priority) - rank(a.priority))
    .slice(0, CONTEXT_ITEMS)
    .flatMap((i) => {
      const id = i.ids.findLast((id) => fresh[Number(id.slice(1)) - 1]?.kind === "slack");
      return id ? [{ id, signal: fresh[Number(id.slice(1)) - 1]! }] : [];
    });
  if (wanted.length === 0) return first;

  const seen = new Set(fresh.map((s) => s.key));
  const context: Context = [];
  for (const source of new Set(wanted.map((w) => w.signal.source))) {
    const server = servers.get(source);
    if (!server) continue; // its session failed to open during collection
    const mine = wanted.filter((w) => w.signal.source === source);
    const fetched = await slackContext(
      source,
      server,
      mine.map((w) => w.signal),
    );
    mine.forEach((w, n) => {
      for (const s of fetched[n]!.sort((a, b) => compareTs(a.ts, b.ts))) {
        if (seen.has(s.key)) continue;
        seen.add(s.key);
        context.push({ for: w.id, signal: s });
      }
    });
  }
  console.log(`context: ${context.length} messages for ${wanted.map((w) => w.id).join(", ")}`);
  return context.length ? triage(root, cfg, fresh, context, afterHours) : first;
}

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
  const handled = readCursors(handledPath);
  const cursors = afterHours ? latest(handled, readCursors(heldPath)) : handled;
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

  // One slack-mcp-server per source for the whole run: a single Slack session covers both
  // collection and the context pass, instead of re-authenticating between them.
  const servers = new Map<string, SlackServer>();
  let fresh: Signal[] = [];
  let result: Triage | undefined;
  let collectFailed = false;
  try {
    const { slack, github, linear, jira, weather, traffic, hackernews, feed } = cfg.sources;
    const collectors: [string, () => Promise<Signal[]>][] = [
      ...Object.entries(slack).map(([name, source]) => [
        `slack/${name}`,
        async () => {
          const server = await openServer(name, ctx);
          servers.set(name, server);
          return collectSlack(name, source, ctx, server);
        },
      ]),
      ...Object.entries(github).map(([name, source]) => [
        `github/${name}`,
        () => collectGithub(name, source, ctx),
      ]),
      ...Object.keys(linear).map((name) => [`linear/${name}`, () => collectLinear(name, ctx)]),
      ...Object.entries(jira).map(([name, source]) => [
        `jira/${name}`,
        () => collectJira(name, source, ctx),
      ]),
      ...Object.entries(weather).map(([name, source]) => [
        `weather/${name}`,
        () => collectWeather(name, source),
      ]),
      ...Object.entries(traffic).map(([name, source]) => [
        `traffic/${name}`,
        () => collectTraffic(name, source, ctx),
      ]),
      ...Object.entries(hackernews).map(([name, source]) => [
        `hackernews/${name}`,
        () => collectHackernews(name, source, ctx),
      ]),
      ...Object.entries(feed).map(([name, source]) => [
        `feed/${name}`,
        () => collectFeed(name, source),
      ]),
    ] as [string, () => Promise<Signal[]>][];
    const collected = await Promise.all(
      collectors.map(async ([id, collect]) => {
        try {
          return await collect();
        } catch (e) {
          failures.push(`source ${id}: ${message(e)}`);
          return [];
        }
      }),
    );
    collectFailed = failures.length > 0;
    fresh = unseen(collected.flat(), cursors, minTs)
      .sort((a, b) => a.time.localeCompare(b.time))
      .map((s) => {
        const floor = floorOf(cfg, s);
        return floor ? { ...s, floor } : s;
      });
    console.log(`${collected.flat().length} unread, ${fresh.length} new`);

    if (fresh.length > 0) {
      try {
        result = await triage(root, cfg, fresh, [], afterHours);
        try {
          result = await withContext(root, cfg, servers, fresh, result, afterHours);
        } catch (e) {
          failures.push(`context: ${message(e)}`); // the first pass still stands
        }
      } catch (e) {
        failures.push(`llm: ${message(e)}`);
        result = fallback(fresh);
      }
    }
  } finally {
    // Close Slack sessions before actions, which may run long-lived agents.
    await Promise.all([...servers.values()].map((s) => s.close().catch(() => {})));
  }

  let notified = false;
  if (result) {
    const { title, summary, items } = toItems(result, fresh);
    const priority = items.reduce<Priority>(
      (p, i) => (rank(i.priority) > rank(p) ? i.priority : p),
      "none",
    );
    console.log(`\n[${priority}] ${title}\n${summary}\n`);
    for (const i of items)
      console.log(`- ${i.priority} ${i.category} (${i.signals.length}): ${i.reason}`);

    if (rank(priority) >= rank(minPriority)) {
      // Link the newest linkable message of the first top-priority item.
      const url = items.find((i) => i.priority === priority)?.signals.findLast((s) => s.url)?.url;
      const argv = tellArgv(root, cfg.notify, priority, title, summary, url);
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
      }
    }

    for (const item of items) {
      if (afterHours && rank(item.priority) < rank(afterHours)) continue; // held for work hours
      for (const [name, action] of Object.entries(cfg.actions)) {
        if (!matches(action, item)) continue;
        if (dryRun) console.log(`would run action ${name} for: ${item.reason}`);
        else {
          const err = await runAction(root, name, action, item);
          if (err) failures.push(err);
        }
      }
    }
    if (!dryRun) writeCursors(cursorsPath, prune(advance(cursors, fresh), minTs));
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
