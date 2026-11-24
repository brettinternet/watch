import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { Item } from "./actions";
import { afterWork, type Config, Duration, type Priority, rank } from "./config";
import { clip } from "./llm";
import { compareTs, readState, type Signal, sourceId, writeState } from "./signal";
import { LINEAR_LOOKBACK_MS } from "./sources/linear";
import { type Mine, THREAD_STREAM } from "./sources/slack";

/**
 * Asks of me that were notified, or that came straight to me and the LLM rated below the
 * threshold, tracked until the source shows them handled. Reminders ride along on the next
 * notification, or go out quietly on their own, at most MAX_REMINDERS times, or once when I've
 * seen the ask and chose not to answer yet.
 */
export type Loop = {
  ask: string;
  priority: Priority;
  /** Opened as a safety net under the threshold: reminds only while still unread or requested. */
  silent?: true;
  anchors: Anchor[];
  url?: string;
  opened: string;
  next: string;
  reminded: string[];
  /** Set only by the CLI. */
  snoozed?: string;
  closed?: { at: string; reason: string };
};
export type Anchor = Pick<
  Signal,
  "key" | "kind" | "source" | "channel" | "ts" | "thread" | "stream" | "to"
>;
export type Followups = Record<string, Loop>;

/** What this run observed, to tell whether each anchor is handled. */
export type Evidence = {
  /** Sources collected this run, as kind/name. */
  ran: Set<string>;
  /** Everything collected, before handled signals are dropped. */
  signals: Signal[];
  now: number;
  /** Slack source name → my recent messages and the caps on its unread scan. */
  slack: Map<string, { mine: Mine[]; maxChannels: number; maxMessages: number }>;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_REMINDERS = 2;
const REMIND_AGAIN = 8 * HOUR; // work hours, so about the next work day
const TTL = 7 * DAY; // open loops expire, and closed ones are forgotten, this long after
const ASKS = new Set(["request", "review"]);

/** Work hours before the first reminder. */
const firstDelay = (p: Priority, silent: boolean) =>
  !silent && rank(p) >= rank("high") ? HOUR : 4 * HOUR;

const isReview = (s: Anchor) => s.kind === "github" && !!s.stream?.endsWith(":review");
/** Kinds with a way to see an ask handled. */
const trackable = (s: Anchor) =>
  s.kind === "slack" || s.kind === "linear" || (s.kind === "github" && !!s.stream);
/**
 * Came straight to me, so the safety net applies even when the LLM rated it low. Thread replies
 * come from search, which carries no unread state to tell a missed one by.
 */
const direct = (s: Signal) =>
  (s.kind === "slack" &&
    (s.to === "dm" || s.to === "me") &&
    s.stream !== THREAD_STREAM &&
    !s.bot) ||
  isReview(s);

/** One conversation: a Slack message and its thread, a PR's stream, or a tracker issue. */
export const conv = (s: Anchor) =>
  s.kind === "slack"
    ? `slack/${s.source}:${s.channel}:${s.thread ?? s.ts}`
    : `${s.kind}/${s.source}:${s.stream ?? s.channel}`;

const anchor = ({ key, kind, source, channel, ts, thread, stream, to }: Signal): Anchor => ({
  key,
  kind,
  source,
  channel,
  ts,
  ...(thread ? { thread } : {}),
  ...(stream ? { stream } : {}),
  ...(to ? { to } : {}),
});

const loopId = (signals: Signal[]) =>
  createHash("sha256")
    .update(
      signals
        .map((s) => s.key)
        .sort()
        .join("\n"),
    )
    .digest("hex")
    .slice(0, 12);

const line = (signals: Signal[], reason: string) =>
  `${signals.at(-1)!.author} · ${signals[0]!.channel}: ${reason}`;

type State = "resolved" | "pending" | "open" | "unsure" | "unknown";

/**
 * Whether the source shows an anchor handled (`resolved`), still waiting on me (`pending`:
 * unread, still requested, still in the inbox), seen but unanswered (`open`), unanswered with
 * unread state unknown (`unsure`), or can't tell at all this run (`unknown`).
 */
export function status(a: Anchor, ev: Evidence): { state: State; reason?: string } {
  const id = `${a.kind}/${a.source}`;
  if (!ev.ran.has(id)) return { state: "unknown" };
  const same = (s: Signal) => sourceId(s) === id;
  switch (a.kind) {
    case "github":
      return ev.signals.some((s) => same(s) && s.stream === a.stream)
        ? { state: "pending" }
        : {
            state: "resolved",
            reason: isReview(a) ? "reviewed or no longer requested" : "merged or no longer ready",
          };
    case "linear":
      if (ev.signals.some((s) => same(s) && s.key === a.key)) return { state: "pending" };
      // The inbox is read back LINEAR_LOOKBACK_MS; older asks just aren't listed.
      if (Number(a.ts) * 1000 < ev.now - LINEAR_LOOKBACK_MS) return { state: "unknown" };
      return { state: "resolved", reason: "read in Linear" };
    case "slack": {
      const slack = ev.slack.get(a.source);
      if (!slack) return { state: "unknown" };
      const root = a.thread ?? a.ts;
      // In a channel, only a reply in the thread answers; in a DM, any later message does.
      const dm = a.to === "dm" || a.to === "group_dm";
      const replied = slack.mine.some(
        (m) =>
          m.channel === a.channel &&
          compareTs(m.ts, a.ts) > 0 &&
          (m.thread === root || (dm && !a.thread && !m.thread)),
      );
      if (replied) return { state: "resolved", reason: "replied in Slack" };
      const unreads = ev.signals.filter((s) => same(s) && s.stream !== THREAD_STREAM);
      if (unreads.some((s) => s.key === a.key)) return { state: "pending" };
      // The scan keeps only so many channels and messages, so a missing message is read only
      // when its channel couldn't have been cut.
      const inChannel = unreads.filter((s) => s.channel === a.channel).length;
      const cut =
        a.thread !== undefined ||
        (inChannel
          ? inChannel >= slack.maxMessages
          : new Set(unreads.map((s) => s.channel)).size >= slack.maxChannels);
      return { state: cut ? "unsure" : "open" };
    }
  }
  return { state: "unknown" };
}

/** Seen without a reply, and nothing suggests it is still unread or requested. */
const seen = (states: State[]) =>
  states.includes("open") && !states.includes("pending") && !states.includes("unsure");
/** Reminders a loop gets: one once I've seen it without acting, since I may have chosen to wait. */
const limit = (states: State[]) => (seen(states) ? 1 : MAX_REMINDERS);

/**
 * Closes loops the evidence shows handled, silent loops read without a reply, and loops past
 * their last reminder or TTL, and forgets loops closed more than TTL ago.
 */
export function update(ledger: Followups, ev: Evidence): Followups {
  const { now } = ev;
  const at = new Date(now).toISOString();
  const next: Followups = {};
  for (const [id, loop] of Object.entries(ledger)) {
    if (loop.closed) {
      if (now - Date.parse(loop.closed.at) < TTL) next[id] = loop;
      continue;
    }
    const checked = loop.anchors.map((a) => status(a, ev));
    const states = checked.map((s) => s.state);
    const done = checked.find((s) => s.state === "resolved");
    const reason = done
      ? done.reason!
      : loop.silent && seen(states)
        ? "read without reply"
        : now - Date.parse(loop.opened) >= TTL ||
            (loop.reminded.length >= limit(states) && Date.parse(loop.next) <= now)
          ? "expired"
          : undefined;
    next[id] = reason ? { ...loop, closed: { at, reason } } : loop;
  }
  return next;
}

/**
 * Open loops due a reminder now, most important first. A loop reminds only when this run could
 * check every anchor and, if silent, it is still unread or requested. Loops in a conversation with new signals
 * this run are skipped, since the summary already covers them.
 */
export function due(ledger: Followups, ev: Evidence, fresh: Signal[]): [string, Loop][] {
  const { now } = ev;
  const active = new Set(fresh.map(conv));
  return Object.entries(ledger)
    .filter(
      ([, l]) =>
        !l.closed &&
        Date.parse(l.next) <= now &&
        (!l.snoozed || Date.parse(l.snoozed) <= now) &&
        !l.anchors.some((a) => active.has(conv(a))),
    )
    .filter(([, l]) => {
      const states = l.anchors.map((a) => status(a, ev).state);
      if (states.includes("unknown")) return false;
      const waiting = states.includes("pending") || (!l.silent && states.length > 0);
      return waiting && l.reminded.length < limit(states);
    })
    .sort(
      ([, a], [, b]) => rank(b.priority) - rank(a.priority) || a.opened.localeCompare(b.opened),
    );
}

/** Records a reminder for each loop and schedules the next. */
export function remind(
  ledger: Followups,
  ids: string[],
  now: number,
  work: Config["work_hours"],
): Followups {
  const next = { ...ledger };
  const nextAt = new Date(afterWork(work, now, REMIND_AGAIN)).toISOString();
  for (const id of ids)
    next[id] = {
      ...next[id]!,
      reminded: [...next[id]!.reminded, new Date(now).toISOString()],
      next: nextAt,
    };
  return next;
}

/**
 * Opens loops for this run's asks. Notified items at or above the threshold that are requests
 * or reviews open loud loops, replacing open loops in the same conversation. Signals that came
 * straight to me and aren't covered open silent loops, unless a loop already covers their
 * conversation.
 */
export function track(
  ledger: Followups,
  items: Item[],
  fresh: Signal[],
  opts: { notified: boolean; minPriority: Priority; now: number; work: Config["work_hours"] },
): Followups {
  const next = { ...ledger };
  const at = new Date(opts.now).toISOString();
  const open = (signals: Signal[], ask: string, priority: Priority, silent: boolean) => {
    const anchors = signals.map(anchor);
    const id = loopId(signals);
    if (next[id]) return;
    const convs = new Set(anchors.map(conv));
    const overlapping = Object.entries(next).filter(
      ([, l]) => !l.closed && l.anchors.some((a) => convs.has(conv(a))),
    );
    if (silent && overlapping.length) return;
    for (const [oid, l] of overlapping)
      next[oid] = { ...l, closed: { at, reason: `superseded by ${id}` } };
    const url = signals.findLast((s) => s.url)?.url;
    next[id] = {
      ask,
      priority,
      ...(silent ? { silent: true as const } : {}),
      anchors,
      ...(url ? { url } : {}),
      opened: at,
      next: new Date(afterWork(opts.work, opts.now, firstDelay(priority, silent))).toISOString(),
      reminded: [],
    };
  };

  const covered = new Set<Signal>();
  if (opts.notified) {
    for (const item of items) {
      const signals = item.signals.filter(trackable);
      if (!signals.length || rank(item.priority) < rank(opts.minPriority)) continue;
      if (!ASKS.has(item.category) && !signals.some(isReview)) continue;
      open(signals, line(item.signals, item.reason), item.priority, false);
      for (const s of item.signals) covered.add(s);
    }
  }
  const groups = new Map<string, Signal[]>();
  for (const s of fresh)
    if (direct(s) && !covered.has(s)) groups.set(conv(s), [...(groups.get(conv(s)) ?? []), s]);
  for (const group of groups.values()) {
    const item = items.find((i) => i.signals.includes(group[0]!));
    const reason = item?.reason ?? clip(group.at(-1)!.text.replace(/\s+/g, " "), 120);
    open(group, line(group, reason), "low", true);
  }
  return next;
}

const age = (from: string, now: number) => {
  const h = Math.max(0, Math.round((now - Date.parse(from)) / HOUR));
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
};

/** One line per loop with how long it has waited. */
export const stillOpen = (loops: Loop[], now: number) =>
  loops.map((l) => `${l.ask} (${age(l.opened, now)})`);

/**
 * Writes the ledger, keeping CLI dismissals and snoozes made since it was read, so `task
 * followups` can run alongside triage.
 */
export function save(path: string, ledger: Followups): void {
  const disk = readState<Followups>(path);
  const next = { ...ledger };
  for (const [id, l] of Object.entries(next)) {
    const d = disk[id];
    if (!d) continue;
    next[id] = {
      ...l,
      ...(d.closed?.reason === "dismissed" && !l.closed ? { closed: d.closed } : {}),
      ...(d.snoozed && (!l.snoozed || d.snoozed > l.snoozed) ? { snoozed: d.snoozed } : {}),
    };
  }
  writeState(path, next);
}

/** What changed between two ledgers, for the run log. */
export function changes(before: Followups, after: Followups): string[] {
  return Object.entries(after).flatMap(([id, l]) =>
    !before[id]
      ? [`opened ${id}${l.silent ? " (silent)" : ""}: ${l.ask}`]
      : l.closed && !before[id]!.closed
        ? [`closed ${id} (${l.closed.reason}): ${l.ask}`]
        : l.reminded.length > before[id]!.reminded.length
          ? [`reminded ${id}: ${l.ask}`]
          : [],
  );
}

export const ledgerPath = (root: string) => join(root, ".state", "followups.json");

function cli(args: string[]): number {
  const path = ledgerPath(resolve(import.meta.dir, ".."));
  const ledger = readState<Followups>(path);
  const now = Date.now();
  const [cmd = "list", prefix, duration] = args;
  if (cmd === "list") {
    const loops = Object.entries(ledger).sort(([, a], [, b]) => a.next.localeCompare(b.next));
    const open = loops.filter(([, l]) => !l.closed);
    for (const [id, l] of open) {
      const until = l.snoozed && Date.parse(l.snoozed) > now ? l.snoozed : l.next;
      const when = Date.parse(until) <= now ? "due" : `next ${new Date(until).toLocaleString()}`;
      const tags = [l.priority, l.silent && "silent", `${l.reminded.length}/${MAX_REMINDERS}`];
      console.log(
        `${id}  ${stillOpen([l], now)[0]}\n      ${tags.filter(Boolean).join(" · ")} · ${when}${l.url ? ` · ${l.url}` : ""}`,
      );
    }
    const closed = loops.filter(([, l]) => l.closed);
    if (closed.length) console.log(`\nclosed in the last ${TTL / DAY}d:`);
    for (const [id, l] of closed) console.log(`${id}  ${l.ask} — ${l.closed!.reason}`);
    if (!loops.length) console.log("no follow-ups");
    return 0;
  }
  if ((cmd !== "done" && cmd !== "snooze") || !prefix || (cmd === "snooze") !== !!duration) {
    console.error(
      "usage: task followups [-- list | done <id> | snooze <id> <duration, e.g. 4h or 2d>]",
    );
    return 2;
  }
  const ids = Object.keys(ledger).filter((id) => id.startsWith(prefix) && !ledger[id]!.closed);
  if (ids.length !== 1) {
    console.error(
      ids.length ? `${prefix} matches ${ids.join(", ")}` : `no open follow-up ${prefix}`,
    );
    return 1;
  }
  const id = ids[0]!;
  const at = new Date(now).toISOString();
  if (cmd === "done") ledger[id] = { ...ledger[id]!, closed: { at, reason: "dismissed" } };
  else {
    const ms = Duration.safeParse(duration);
    if (!ms.success) {
      console.error(ms.error.issues[0]!.message);
      return 2;
    }
    ledger[id] = { ...ledger[id]!, snoozed: new Date(now + ms.data).toISOString() };
  }
  writeState(path, ledger);
  console.log(
    `${cmd === "done" ? "dismissed" : `snoozed until ${ledger[id]!.snoozed}`}: ${ledger[id]!.ask}`,
  );
  return 0;
}

if (import.meta.main) process.exit(cli(process.argv.slice(2)));
