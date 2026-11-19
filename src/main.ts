import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Item, matches, runAction } from "./actions";
import { type Config, type Priority, type Source, loadConfig, rank } from "./config";
import { fallback, triage, type Triage } from "./llm";
import { notify, tellArgv } from "./notify";
import { advance, readCursors, type Signal, unseen, writeCursors } from "./signal";
import { collectSlack } from "./sources/slack";

const NOOP = 78; // noon.yaml noop_exit_code: nothing new or nothing worth notifying

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function collect(name: string, source: Source, ctx: { stateDir: string; env: typeof process.env }) {
  switch (source.kind) {
    case "slack":
      return collectSlack(name, source, ctx);
  }
}

function toItems(t: Triage, signals: Signal[]): Item[] {
  return t.items.flatMap((i) => {
    const matched = i.ids.flatMap((id) => signals[Number(id.slice(1)) - 1] ?? []);
    return matched.length
      ? [{ priority: i.priority, category: i.category, reason: i.reason, signals: matched }]
      : [];
  });
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

  const collected = await Promise.all(
    Object.entries(cfg.sources).map(async ([name, source]) => {
      try {
        return await collect(name, source, { stateDir, env: process.env });
      } catch (e) {
        failures.push(`source ${name}: ${message(e)}`);
        return [];
      }
    }),
  );
  const minTs = String(Math.floor((Date.now() - cfg.max_age) / 1000));
  const fresh = unseen(collected.flat(), cursors, minTs).sort((a, b) =>
    a.time.localeCompare(b.time),
  );
  console.log(`${collected.flat().length} unread, ${fresh.length} new`);

  let notified = false;
  if (fresh.length > 0) {
    let result: Triage;
    try {
      result = await triage(root, cfg, fresh);
    } catch (e) {
      failures.push(`llm: ${message(e)}`);
      result = fallback(fresh);
    }
    const items = toItems(result, fresh);
    const priority = items.reduce<Priority>(
      (p, i) => (rank(i.priority) > rank(p) ? i.priority : p),
      "none",
    );
    console.log(`\n[${priority}] ${result.title}\n${result.summary}\n`);
    for (const i of items)
      console.log(`- ${i.priority} ${i.category} (${i.signals.length}): ${i.reason}`);

    if (rank(priority) >= rank(cfg.notify.min_priority)) {
      const argv = tellArgv(root, cfg.notify, priority, result.title, result.summary);
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
