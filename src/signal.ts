import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Priority } from "./config";

/** One message or event from a source. `ts` orders signals within a channel. */
export type Signal = {
  key: string;
  source: string;
  kind: string;
  channel: string;
  /** Decimal timestamp, e.g. a Slack message ts like "1700000000.000100". */
  ts: string;
  time: string;
  author: string;
  /** Author's email when the source exposes it; matches `vips`. */
  email?: string;
  text: string;
  thread?: string;
  /** Cursor stream within the source when it differs from `channel`. */
  stream?: string;
  /** Link to open the signal at its source. */
  url?: string;
  /** Who a message is for, when the source can tell, e.g. Slack's "dm", "me", or "others". */
  to?: string;
  /** Minimum priority from `vips` or `priority_channels`, set after collection. */
  floor?: Priority;
};

/** The configured source a signal came from, as kind/name, e.g. slack/acme. */
export const sourceId = (s: Signal) => `${s.kind}/${s.source}`;

/** kind/name source → stream (channel by default) → highest ts already handled. */
export type Cursors = Record<string, Record<string, string>>;

/** Shared context passed to every source collector. `since` is an ISO lower bound for fetches. */
export type CollectCtx = {
  stateDir: string;
  env: Record<string, string | undefined>;
  since: string;
  /** Lowercased VIP emails, which skip a source's exclusions. */
  vips: Set<string>;
};

/** Compares decimal timestamps exactly; Number() would lose Slack's microsecond digits. */
export function compareTs(a: string, b: string): number {
  const [ai = "0", af = ""] = a.split(".");
  const [bi = "0", bf = ""] = b.split(".");
  if (ai.length !== bi.length) return ai.length - bi.length;
  if (ai !== bi) return ai < bi ? -1 : 1;
  const width = Math.max(af.length, bf.length);
  const [x, y] = [af.padEnd(width, "0"), bf.padEnd(width, "0")];
  return x === y ? 0 : x < y ? -1 : 1;
}

/** kind/name source → its own lower bound, when it reaches back further than the run's. */
export type Windows = Record<string, string>;

/** Signals not yet handled and no older than `minTs`, or their source's window. */
export function unseen(
  signals: Signal[],
  cursors: Cursors,
  minTs: string,
  windows: Windows = {},
): Signal[] {
  return signals.filter((s) => {
    const cursor = cursors[sourceId(s)]?.[s.stream ?? s.channel];
    const min = windows[sourceId(s)] ?? minTs;
    return compareTs(s.ts, min) >= 0 && (cursor === undefined || compareTs(s.ts, cursor) > 0);
  });
}

export function advance(cursors: Cursors, signals: Signal[]): Cursors {
  const next: Cursors = structuredClone(cursors);
  for (const s of signals) {
    const channels = (next[sourceId(s)] ??= {});
    const stream = s.stream ?? s.channel;
    const cursor = channels[stream];
    if (cursor === undefined || compareTs(s.ts, cursor) > 0) channels[stream] = s.ts;
  }
  return next;
}

/**
 * Drops cursors older than `minTs` or their source's window: `unseen` already skips anything
 * that old, and per-item streams (stories, traffic events) would otherwise grow the file forever.
 */
export function prune(cursors: Cursors, minTs: string, windows: Windows = {}): Cursors {
  const next: Cursors = {};
  for (const [source, streams] of Object.entries(cursors)) {
    const min = windows[source] ?? minTs;
    const kept = Object.entries(streams).filter(([, ts]) => compareTs(ts, min) >= 0);
    if (kept.length) next[source] = Object.fromEntries(kept);
  }
  return next;
}

/** Per stream, the later of two cursors. */
export function latest(a: Cursors, b: Cursors): Cursors {
  const next: Cursors = structuredClone(a);
  for (const [source, streams] of Object.entries(b)) {
    const channels = (next[source] ??= {});
    for (const [stream, ts] of Object.entries(streams)) {
      const cursor = channels[stream];
      if (cursor === undefined || compareTs(ts, cursor) > 0) channels[stream] = ts;
    }
  }
  return next;
}

export function readState<T extends object>(path: string): T {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : ({} as T);
}

export function writeState(path: string, state: object): void {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
