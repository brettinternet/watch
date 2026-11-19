import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Item, matches, runAction } from "./actions";
import { type Config, type Priority, loadConfig, rank } from "./config";
import { type Context, fallback, triage, type Triage } from "./llm";
import { notify, tellArgv } from "./notify";
import {
  advance,
  type CollectCtx,
  compareTs,
  readCursors,
  type Signal,
  unseen,
  writeCursors,
} from "./signal";
import { collectGithub } from "./sources/github";
import { collectSlack, openServer, type SlackServer, slackContext } from "./sources/slack";

const NOOP = 78; // noon.yaml noop_exit_code: nothing new or nothing worth notifying
const CONTEXT_ITEMS = 3; // most flagged items per run that get Slack context and a second pass

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function toItems(t: Triage, signals: Signal[]): Item[] {
  return t.items.flatMap((i) => {
    const matched = i.ids.flatMap((id) => signals[Number(id.slice(1)) - 1] ?? []);
    return matched.length
      ? [{ priority: i.priority, category: i.category, reason: i.reason, signals: matched }]
      : [];
  });
}

/**
 * Fetches Slack context for the most important items the LLM flagged at or above
 * notify.min_priority and triages once more with it; otherwise returns `first`.
 */
async function withContext(
  root: string,
  cfg: Config,
  servers: Map<string, SlackServer>,
  fresh: Signal[],
  first: Triage,
): Promise<Triage> {
  const wanted = first.items
    .filter((i) => i.needs_context && rank(i.priority) >= rank(cfg.notify.min_priority))
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
      server.call,
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
  return context.length ? triage(root, cfg, fresh, context) : first;
}

async function main(dryRun: boolean): Promise<number> {
  const root = resolve(import.meta.dir, "..");
  const cfg: Config = loadConfig(root);
  if (Object.keys(cfg.sources).length === 0)
    throw new Error("no sources configured; add one to triage.local.yaml");

  const stateDir = join(root, ".state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const cursorsPath = join(stateDir, "cursors.json");
  const cursors = readCursors(cursorsPath);
  const failures: string[] = [];

  const minTs = String(Math.floor((Date.now() - cfg.max_age) / 1000));
  const since = new Date(Date.now() - cfg.max_age).toISOString();
  const ctx: CollectCtx = { stateDir, env: process.env, since };

  // One slack-mcp-server per source for the whole run: a single Slack session covers both
  // collection and the context pass, instead of re-authenticating between them.
  const servers = new Map<string, SlackServer>();
  let fresh: Signal[] = [];
  let result: Triage | undefined;
  try {
    const collected = await Promise.all(
      Object.entries(cfg.sources).map(async ([name, source]) => {
        try {
          if (source.kind === "github") return await collectGithub(name, source, ctx);
          const server = await openServer(name, ctx);
          servers.set(name, server);
          return await collectSlack(name, source, ctx, server);
        } catch (e) {
          failures.push(`source ${name}: ${message(e)}`);
          return [];
        }
      }),
    );
    fresh = unseen(collected.flat(), cursors, minTs).sort((a, b) => a.time.localeCompare(b.time));
    console.log(`${collected.flat().length} unread, ${fresh.length} new`);

    if (fresh.length > 0) {
      try {
        result = await triage(root, cfg, fresh);
        try {
          result = await withContext(root, cfg, servers, fresh, result);
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
    const items = toItems(result, fresh);
    const priority = items.reduce<Priority>(
      (p, i) => (rank(i.priority) > rank(p) ? i.priority : p),
      "none",
    );
    console.log(`\n[${priority}] ${result.title}\n${result.summary}\n`);
    for (const i of items)
      console.log(`- ${i.priority} ${i.category} (${i.signals.length}): ${i.reason}`);

    if (rank(priority) >= rank(cfg.notify.min_priority)) {
      // Link the newest linkable message of the first top-priority item.
      const url = items.find((i) => i.priority === priority)?.signals.findLast((s) => s.url)?.url;
      const argv = tellArgv(root, cfg.notify, priority, result.title, result.summary, url);
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
      for (const [name, action] of Object.entries(cfg.actions)) {
        if (!matches(action, item)) continue;
        if (dryRun) console.log(`would run action ${name} for: ${item.reason}`);
        else {
          const err = await runAction(root, name, action, item);
          if (err) failures.push(err);
        }
      }
    }
    if (!dryRun) writeCursors(cursorsPath, advance(cursors, fresh));
  }

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
