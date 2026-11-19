import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

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
  text: string;
  thread?: string;
};

/** source → channel → highest ts already handled. */
export type Cursors = Record<string, Record<string, string>>;

/** Shared context passed to every source collector. `since` is an ISO lower bound for fetches. */
export type CollectCtx = {
  stateDir: string;
  env: Record<string, string | undefined>;
  since: string;
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

/** Signals not yet handled and no older than `minTs`. */
export function unseen(signals: Signal[], cursors: Cursors, minTs: string): Signal[] {
  return signals.filter((s) => {
    const cursor = cursors[s.source]?.[s.channel];
    return compareTs(s.ts, minTs) >= 0 && (cursor === undefined || compareTs(s.ts, cursor) > 0);
  });
}

export function advance(cursors: Cursors, signals: Signal[]): Cursors {
  const next: Cursors = structuredClone(cursors);
  for (const s of signals) {
    const channels = (next[s.source] ??= {});
    const cursor = channels[s.channel];
    if (cursor === undefined || compareTs(s.ts, cursor) > 0) channels[s.channel] = s.ts;
  }
  return next;
}

export function readCursors(path: string): Cursors {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

export function writeCursors(path: string, cursors: Cursors): void {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(cursors, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
