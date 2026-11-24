import { type Config, type Priority, rank } from "./config";
import { raised } from "./items";
import { type Context, triage, type Triage } from "./llm";
import { compareTs, type Signal } from "./signal";
import { prState } from "./sources/github";
import { issueState } from "./sources/linear";
import { type SlackServer, slackContext } from "./sources/slack";

const ITEMS = 3; // most flagged items per run that get look-ups and a second pass
const PER_ITEM = 3; // most look-ups per item

/** One read-only look-up the LLM asked for; `for` is the message id it explains. */
export type Lookup =
  | { what: "thread"; for: string; signal: Signal }
  | { what: "pr"; for: string; source: string; repo: string; n: number }
  | { what: "issue"; for: string; sources: string[]; issue: string };

const label = (l: Lookup) =>
  l.what === "thread" ? `thread of ${l.for}` : l.what === "pr" ? `${l.repo}#${l.n}` : l.issue;

/**
 * The look-ups the LLM asked for on the most important items at or above `minPriority`, kept to
 * what configured sources reach: the Slack thread of a collected message, a PR in a configured
 * repo, or an issue in a configured Linear workspace. The LLM names what it needs; code alone
 * decides whether and how to fetch it, so message text can't steer a request anywhere else.
 */
export function lookups(
  cfg: Config,
  fresh: Signal[],
  first: Triage,
  minPriority: Priority,
): Lookup[] {
  const at = (id: string) => fresh[Number(id.slice(1)) - 1];
  const repos = new Map(
    Object.entries(cfg.sources.github).flatMap(([source, s]) =>
      s.repos.map((repo) => [repo.toLowerCase(), { source, repo }] as const),
    ),
  );
  const linear = Object.keys(cfg.sources.linear);
  return first.items
    .map((i) => ({
      ...i,
      priority: raised(
        i.priority,
        i.ids.flatMap((id) => at(id) ?? []),
      ),
    }))
    .filter((i) => i.verify?.length && rank(i.priority) >= rank(minPriority))
    .sort((a, b) => rank(b.priority) - rank(a.priority))
    .slice(0, ITEMS)
    .flatMap((i) =>
      [...new Set(i.verify)]
        .flatMap((want): Lookup[] => {
          if (want === "thread") {
            const id = i.ids.findLast((id) => at(id)?.kind === "slack");
            return id ? [{ what: "thread", for: id, signal: at(id)! }] : [];
          }
          const pr = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(want);
          const scope = pr && repos.get(pr[1]!.toLowerCase());
          if (scope) return [{ what: "pr", for: i.ids[0]!, ...scope, n: Number(pr[2]) }];
          if (/^[A-Z][A-Z0-9]*-\d+$/.test(want) && linear.length)
            return [{ what: "issue", for: i.ids[0]!, sources: linear, issue: want }];
          console.log(`look-up skipped, out of scope: ${JSON.stringify(want).slice(0, 80)}`);
          return [];
        })
        .slice(0, PER_ITEM),
    );
}

async function look(l: Lookup, servers: Map<string, SlackServer>): Promise<Signal[]> {
  switch (l.what) {
    case "thread": {
      const server = servers.get(l.signal.source);
      if (!server) return []; // its session failed to open during collection
      return (await slackContext(l.signal.source, server, [l.signal]))[0]!;
    }
    case "pr":
      return [await prState(l.source, l.repo, l.n, process.env)];
    case "issue": {
      // An identifier names no workspace, so ask each until one has it.
      let error: unknown;
      for (const name of l.sources) {
        try {
          return [await issueState(name, l.issue, process.env)];
        } catch (e) {
          error = e;
        }
      }
      throw error;
    }
  }
}

/**
 * Runs the look-ups the LLM asked for and triages once more with what they found; otherwise,
 * or when nothing was found, returns `first`. A failed look-up is logged and skipped.
 */
export async function verify(
  root: string,
  cfg: Config,
  servers: Map<string, SlackServer>,
  fresh: Signal[],
  first: Triage,
  afterHours?: Priority,
): Promise<Triage> {
  const wanted = lookups(cfg, fresh, first, afterHours ?? cfg.notify.min_priority);
  if (wanted.length === 0) return first;

  const seen = new Set(fresh.map((s) => s.key));
  const context: Context = [];
  for (const l of wanted) {
    let found: Signal[];
    try {
      found = await look(l, servers);
    } catch (e) {
      console.error(`look-up ${label(l)}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const s of found.sort((a, b) => compareTs(a.ts, b.ts))) {
      if (seen.has(s.key)) continue;
      seen.add(s.key);
      context.push({ for: l.for, signal: s });
    }
  }
  console.log(`context: ${context.length} entries from ${wanted.map(label).join(", ")}`);
  return context.length ? triage(root, cfg, fresh, context, afterHours) : first;
}
