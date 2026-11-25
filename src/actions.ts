import { createHash } from "node:crypto";
import { join } from "node:path";
import { type Action, type Priority, rank } from "./config";
import { compareTs, readState, type Signal, sourceId, writeState } from "./signal";
import { readChannels } from "./sources/slack";

export type Item = { priority: Priority; category: string; reason: string; signals: Signal[] };

/**
 * Whether an action applies to an item. Matching runs in code before the notify decision, so
 * a command action that forces a notification applies to the item, not just its priority.
 */
function matches(action: Action, item: Item, now: number): boolean {
  const { categories, min_priority, max_priority, after } = action.when;
  return (
    rank(item.priority) >= rank(min_priority) &&
    (!max_priority || rank(item.priority) <= rank(max_priority)) &&
    (after === undefined || new Date(now).getHours() >= after) &&
    (!categories || categories.includes(item.category)) &&
    item.signals.some((s) => signalMatches(action.when, s))
  );
}

export type Run = { name: string; action: Action; item: Item };

/** Every action that applies to each item. */
export function actionRuns(actions: Record<string, Action>, items: Item[], now: number): Run[] {
  return items.flatMap((item) =>
    Object.entries(actions)
      .filter(([, action]) => matches(action, item, now))
      .map(([name, action]) => ({ name, action, item })),
  );
}

/** Command runs that force a notification, so a loud action never runs unannounced. */
export const loudRuns = (runs: Run[]) => runs.filter((r) => r.action.run && !r.action.quiet);

function signalMatches(when: Action["when"], s: Signal): boolean {
  const { sources, channels, to, bot, text } = when;
  return (
    (!sources || sources.includes(sourceId(s))) &&
    (!channels || channels.includes(s.channel.replace(/^#/, ""))) &&
    (!to || (s.to !== undefined && to.includes(s.to))) &&
    (bot === undefined || !!s.bot === bot) &&
    (!text || text.test(s.text))
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

/** A Slack message of a triaged item: its action's agent may act on it and its thread. */
export type ReplyTarget = {
  /** The signal's key, which the agent names it by. */
  message: string;
  source: string;
  /** Channel id, which slack-mcp-server's write allowlists match. */
  channel: string;
  ts: string;
  thread: string;
};
/**
 * Item key → when its action ran, where its agent may write in Slack, and its signals' keys,
 * whose follow-ups it may dismiss or snooze.
 */
export type Replies = Record<string, { at: number; targets: ReplyTarget[]; keys: string[] }>;

const REPLIES_TTL_MS = 7 * 864e5;

/**
 * Channel name → id from a workspace's triage cache; slack-mcp-server reports an uncached
 * channel by its id. Undefined when neither.
 */
export function channelIds(stateDir: string, source: string): (name: string) => string | undefined {
  const ids = new Map(readChannels(join(stateDir, "slack", source)).map((c) => [c.name, c.id]));
  return (name) => ids.get(name) ?? (/^[CDG][A-Z0-9]+$/.test(name) ? name : undefined);
}

/**
 * Records what `task slack:reply` lets the item's agent touch: its Slack messages, leaving out
 * one whose channel id isn't in the triage cache, and its signals' follow-ups.
 */
export function recordReplies(stateDir: string, item: Item, now: number): void {
  const lookups = new Map<string, (name: string) => string | undefined>();
  const targets: ReplyTarget[] = [];
  for (const s of item.signals) {
    if (s.kind !== "slack") continue;
    let id = lookups.get(s.source);
    if (!id) lookups.set(s.source, (id = channelIds(stateDir, s.source)));
    const channel = id(s.channel);
    if (channel)
      targets.push({
        message: s.key,
        source: s.source,
        channel,
        ts: s.ts,
        thread: s.thread ?? s.ts,
      });
  }
  const path = join(stateDir, "replies.json");
  const replies = Object.fromEntries(
    Object.entries(readState<Replies>(path)).filter(([, r]) => now - r.at < REPLIES_TTL_MS),
  );
  replies[itemKey(item)] = {
    at: now,
    targets: targets.sort((a, b) => compareTs(a.ts, b.ts)),
    keys: item.signals.map((s) => s.key),
  };
  writeState(path, replies);
}

/** The target `message` names or, when omitted, the latest message of the item's only thread. */
export function replyTarget(targets: ReplyTarget[], message?: string): ReplyTarget {
  if (!targets.length) throw new Error("the item has no Slack messages");
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
  const argv = typeof action.run === "string" ? ["/bin/sh", "-c", action.run] : action.run!;
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
