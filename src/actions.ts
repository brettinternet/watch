import { createHash } from "node:crypto";
import { join } from "node:path";
import { type Action, type Priority, rank } from "./config";
import { compareTs, readState, type Signal, sourceId, writeState } from "./signal";
import { readChannels } from "./sources/slack";

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

/** The environment for commands that act on untrusted message text: no secrets. */
export function minimalEnv(env: Record<string, string | undefined>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env))
    if (v && (INHERIT.includes(k) || k.startsWith("XDG_"))) out[k] = v;
  return out;
}

export function actionEnv(env: Record<string, string | undefined>, name: string, item: Item) {
  return {
    ...minimalEnv(env),
    TRIAGE_ACTION: name,
    TRIAGE_KEY: itemKey(item),
    TRIAGE_PRIORITY: item.priority,
    TRIAGE_CATEGORY: item.category,
  };
}

/** A Slack message of a triaged item: its action's agent may react to it and reply in its thread. */
export type ReplyTarget = {
  /** The signal's key, which the agent names it by. */
  message: string;
  source: string;
  /** Channel id, which slack-mcp-server's write allowlists match. */
  channel: string;
  ts: string;
  thread: string;
};
/** Item key → when its action ran and where its agent may write. */
export type Replies = Record<string, { at: number; targets: ReplyTarget[] }>;

const REPLIES_TTL_MS = 7 * 864e5;

/**
 * Records the item's Slack messages, the only places `task slack:reply` lets its agent write.
 * A message whose channel id isn't in the triage cache is left out.
 */
export function recordReplies(stateDir: string, item: Item, now: number): void {
  const names = new Map<string, Map<string, string>>();
  const targets: ReplyTarget[] = [];
  for (const s of item.signals) {
    if (s.kind !== "slack") continue;
    let ids = names.get(s.source);
    if (!ids) {
      ids = new Map(readChannels(join(stateDir, "slack", s.source)).map((c) => [c.name, c.id]));
      names.set(s.source, ids);
    }
    // The server reports an uncached channel by its id.
    const channel = ids.get(s.channel) ?? (/^[CDG][A-Z0-9]+$/.test(s.channel) ? s.channel : "");
    if (channel)
      targets.push({
        message: s.key,
        source: s.source,
        channel,
        ts: s.ts,
        thread: s.thread ?? s.ts,
      });
  }
  if (targets.length === 0) return;
  const path = join(stateDir, "replies.json");
  const replies = Object.fromEntries(
    Object.entries(readState<Replies>(path)).filter(([, r]) => now - r.at < REPLIES_TTL_MS),
  );
  replies[itemKey(item)] = { at: now, targets: targets.sort((a, b) => compareTs(a.ts, b.ts)) };
  writeState(path, replies);
}

/** The target `message` names or, when omitted, the latest message of the item's only thread. */
export function replyTarget(targets: ReplyTarget[], message?: string): ReplyTarget {
  const keys = targets.map((t) => t.message).join(", ");
  if (message !== undefined) {
    const target = targets.find((t) => t.message === message);
    if (!target) throw new Error(`message must be one of: ${keys}`);
    return target;
  }
  const threads = new Set(targets.map((t) => `${t.source}:${t.channel}:${t.thread}`));
  if (threads.size !== 1)
    throw new Error(`the item spans several threads; pass message, one of: ${keys}`);
  return targets.at(-1)!;
}

/** Runs one action with the item as JSON on stdin. Returns an error message, or undefined on success. */
export async function runAction(
  root: string,
  name: string,
  action: Action,
  item: Item,
): Promise<string | undefined> {
  recordReplies(join(root, ".state"), item, Date.now());
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
