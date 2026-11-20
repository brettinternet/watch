import { createHash } from "node:crypto";
import { type Action, type Priority, rank } from "./config";
import { type Signal, sourceId } from "./signal";

export type Item = { priority: Priority; category: string; reason: string; signals: Signal[] };

export function matches(action: Action, item: Item): boolean {
  const { categories, sources, min_priority } = action.when;
  return (
    rank(item.priority) >= rank(min_priority) &&
    (!categories || categories.includes(item.category)) &&
    (!sources || item.signals.some((s) => sources.includes(sourceId(s))))
  );
}

/** Stable per item, so a downstream `noon run --key "$TRIAGE_KEY"` dedupes retries. */
export function itemKey(item: Item): string {
  const keys = item.signals.map((s) => s.key).sort();
  return `triage-${createHash("sha256").update(keys.join("\n")).digest("hex").slice(0, 16)}`;
}

// Actions get a minimal environment: never the Slack/Pushover secrets or the parent Noon run's NOON_*.
const INHERIT = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "TZ",
];

export function actionEnv(env: Record<string, string | undefined>, name: string, item: Item) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env))
    if (v && (INHERIT.includes(k) || k.startsWith("XDG_"))) out[k] = v;
  return {
    ...out,
    TRIAGE_ACTION: name,
    TRIAGE_KEY: itemKey(item),
    TRIAGE_PRIORITY: item.priority,
    TRIAGE_CATEGORY: item.category,
  };
}

/** Runs one action with the item as JSON on stdin. Returns an error message, or undefined on success. */
export async function runAction(
  root: string,
  name: string,
  action: Action,
  item: Item,
): Promise<string | undefined> {
  const argv = typeof action.run === "string" ? ["/bin/sh", "-c", action.run] : action.run;
  const proc = Bun.spawn(argv, {
    cwd: root,
    env: actionEnv(process.env, name, item),
    stdin: new Blob([JSON.stringify({ action: name, key: itemKey(item), ...item })]),
    stdout: "inherit",
    stderr: "inherit",
    timeout: action.timeout,
  });
  const code = await proc.exited;
  return code === 0 ? undefined : `action ${name} exited ${code}`;
}
