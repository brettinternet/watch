import type { Item } from "./actions";
import { type Config, type Priority, rank } from "./config";
import { clip, joinSummary, type Triage } from "./llm";
import type { Signal } from "./signal";

const higher = (a: Priority, b: Priority | undefined) => (b && rank(b) > rank(a) ? b : a);

/**
 * The minimum priority `vips` and `priority_channels` set for a signal, if any. A VIP's floor
 * skips Slack messages addressed to no one or to others, e.g. thanking someone else in a channel.
 */
export function floorOf(cfg: Config, s: Signal): Priority | undefined {
  const forOthers = s.kind === "slack" && (!s.to || s.to === "others");
  const vip = s.email && !forOthers ? cfg.vips[s.email.toLowerCase()] : undefined;
  const channel =
    s.kind === "slack"
      ? cfg.sources.slack[s.source]?.priority_channels[s.channel.replace(/^#/, "")]
      : undefined;
  return vip ? higher(vip, channel) : channel;
}

/** A priority raised to the highest floor among `signals`. */
export const raised = (p: Priority, signals: Signal[]) =>
  signals.reduce((q, s) => higher(q, s.floor), p);

export type Triaged = { title: string; summary: string; items: Item[] };

/** A summary line for an item, as "Name · #channel: reason". */
export const itemLine = (i: Item) =>
  `${i.signals.at(-1)!.author} · ${i.signals[0]!.channel}: ${i.reason}`;

/**
 * Items from the LLM's triage with priorities raised to their signals' floors. Floored signals
 * the LLM skipped become items, and those and raised items the summary leaves out by its rules
 * (none, or low beside normal and up) get a summary line, so a VIP or priority channel always
 * shows up.
 */
export function toItems(t: Triage, signals: Signal[]): Triaged {
  const claimed = new Set<Signal>();
  const llm = t.items.flatMap((i) => {
    const matched = i.ids.flatMap((id) => signals[Number(id.slice(1)) - 1] ?? []);
    for (const s of matched) claimed.add(s);
    return matched.length
      ? [{ priority: i.priority, category: i.category, reason: i.reason, signals: matched }]
      : [];
  });
  const top = llm.reduce<Priority>((p, i) => higher(p, i.priority), "none");
  const summarized = (p: Priority) => p !== "none" && (p !== "low" || rank(top) < rank("normal"));

  const forced: Item[] = [];
  const items = llm.map((i) => {
    const item = { ...i, priority: raised(i.priority, i.signals) };
    if (item.priority !== i.priority && !summarized(i.priority)) forced.push(item);
    return item;
  });
  const skipped = new Map<string, Signal[]>();
  for (const s of signals) {
    if (!s.floor || claimed.has(s)) continue;
    const where = `${s.kind}/${s.source} ${s.channel}`;
    skipped.set(where, [...(skipped.get(where) ?? []), s]);
  }
  for (const group of skipped.values()) {
    const last = group.at(-1)!;
    const item = {
      priority: raised("none", group),
      category: "",
      reason: clip(last.text.replace(/\s+/g, " "), 120),
      signals: group,
    };
    items.push(item);
    forced.push(item);
  }
  if (!forced.length) return { title: t.title, summary: t.summary, items };

  forced.sort((a, b) => rank(b.priority) - rank(a.priority));
  const lines = forced.map(itemLine);
  const rest = items.filter((i) => !forced.includes(i));
  const restTop = rest.reduce<Priority>((p, i) => higher(p, i.priority), "none");
  return {
    // A forced item that outranks everything the LLM summarized takes over the headline.
    title: rank(forced[0]!.priority) > rank(restTop) ? clip(lines[0]!, 100) : t.title,
    summary: joinSummary([
      ...lines,
      ...t.summary.split("\n").flatMap((l) => l.replace(/^• /, "") || []),
    ]),
    items,
  };
}
