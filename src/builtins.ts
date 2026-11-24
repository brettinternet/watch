/**
 * Built-in actions run inside triage with no agent, on the category and priority triage already
 * assigned, so they behave the same on every host whatever its agent setup.
 */
import { join } from "node:path";
import { channelIds, type Item } from "./actions";
import { type Action, type BUILTINS, type Config, nextWorkStart } from "./config";
import { type Followups, settleKeys } from "./followups";
import { compareTs, type Signal } from "./signal";
import { callText, connectServer, lastRead, serverEnv, THREAD_STREAM } from "./sources/slack";

export type Run = { name: string; action: Action; item: Item };
type Mark = { source: string; channel: string; ts: string };

/**
 * Where to mark each channel read: its latest unread message such that every unread message up
 * to it is cleared, so marking never hides one that isn't. `complete` says whether a channel's
 * unread messages were all scanned; if not, an unseen earlier one might be hidden.
 */
export function readUpTo(
  all: Signal[],
  cleared: Set<string>,
  complete: (source: string, channel: string, count: number) => boolean,
): Mark[] {
  const channels = new Map<string, Signal[]>();
  for (const s of all) {
    // Thread replies carry no unread state.
    if (s.kind !== "slack" || s.stream === THREAD_STREAM) continue;
    const k = `${s.source}\0${s.channel}`;
    channels.set(k, [...(channels.get(k) ?? []), s]);
  }
  const marks: Mark[] = [];
  for (const unread of channels.values()) {
    const { source, channel } = unread[0]!;
    if (!complete(source, channel, unread.length)) continue;
    unread.sort((a, b) => compareTs(a.ts, b.ts));
    const kept = unread.findIndex((s) => !cleared.has(s.key));
    const last = unread[(kept === -1 ? unread.length : kept) - 1];
    if (last) marks.push({ source, channel, ts: last.ts });
  }
  return marks;
}

/** Runs `do` actions: dismiss and snooze settle follow-ups in `ledger`, mark_read marks Slack. */
export async function runBuiltins(
  runs: Run[],
  ctx: {
    stateDir: string;
    cfg: Config;
    all: Signal[];
    /** Every triaged item. */
    items: Item[];
    ledger: Followups;
    now: number;
    dryRun: boolean;
    env: Record<string, string | undefined>;
  },
): Promise<{ ledger: Followups; failures: string[] }> {
  const { stateDir, cfg, now, dryRun } = ctx;
  const failures: string[] = [];
  // A signal can be in several items; one also in an item not taking a step keeps it out.
  const keysFor = (step: (typeof BUILTINS)[number]) => {
    const doing = new Set(runs.filter((r) => r.action.do?.includes(step)).map((r) => r.item));
    const kept = new Set(
      ctx.items.filter((i) => !doing.has(i)).flatMap((i) => i.signals.map((s) => s.key)),
    );
    return new Set(
      [...doing].flatMap((i) => i.signals.map((s) => s.key)).filter((k) => !kept.has(k)),
    );
  };
  let ledger = settleKeys(ctx.ledger, keysFor("dismiss"), now).ledger;
  const until = nextWorkStart(cfg.work_hours, now);
  ledger = settleKeys(ledger, keysFor("snooze"), now, until).ledger;

  const marks = readUpTo(ctx.all, keysFor("mark_read"), (source, channel, count) => {
    const s = cfg.sources.slack[source];
    // mentions_only and excluded channels scan only some of a channel's messages.
    return (
      !!s &&
      !s.mentions_only &&
      !s.exclude_channels.includes(channel) &&
      count < s.max_messages_per_channel
    );
  });
  const sources = new Map<string, Mark[]>();
  for (const m of marks) sources.set(m.source, [...(sources.get(m.source) ?? []), m]);
  for (const [source, ms] of sources) {
    if (dryRun) {
      for (const m of ms) console.log(`would mark slack/${source} ${m.channel} read`);
      continue;
    }
    try {
      const client = await connectServer(source, {
        ...serverEnv(source, ctx.env, join(stateDir, "slack", source)),
        SLACK_MCP_ENABLED_TOOLS: "conversations_unreads,conversations_mark",
        SLACK_MCP_MARK_TOOL: "true",
      });
      try {
        const read = await lastRead(client, cfg.sources.slack[source]);
        const id = channelIds(stateDir, source);
        for (const m of ms) {
          const channel = id(m.channel);
          const last = channel === undefined ? undefined : read.get(channel);
          // Gone from unreads or read further since the scan: marking would move the marker back.
          if (channel === undefined || last === undefined || last >= m.ts) continue;
          await callText(client, "conversations_mark", { channel_id: channel, ts: m.ts });
          console.log(`marked slack/${source} ${m.channel} read`);
        }
      } finally {
        await client.close();
      }
    } catch (e) {
      failures.push(`mark_read slack/${source}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ledger, failures };
}
