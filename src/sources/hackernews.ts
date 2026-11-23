import type { HackernewsSource } from "../config";
import { fetchJson } from "../http";
import type { CollectCtx, Signal } from "../signal";

type Hit = {
  objectID: string;
  title: string;
  url: string | null;
  author: string;
  points: number;
  num_comments: number;
  created_at_i: number;
};

/**
 * Stories posted since `ctx.since` with at least `min_points`, through HN's Algolia search.
 * Each story is its own cursor stream: one crosses the threshold hours after it's posted, so it
 * can arrive after newer stories already advanced a shared cursor past it.
 */
export async function collectHackernews(
  name: string,
  source: HackernewsSource,
  ctx: CollectCtx,
): Promise<Signal[]> {
  const since = Math.floor(Date.parse(ctx.since) / 1000);
  const query = new URLSearchParams({
    tags: "story",
    numericFilters: `points>=${source.min_points},created_at_i>=${since}`,
    hitsPerPage: "100",
  });
  const { hits } = await fetchJson<{ hits: Hit[] }>(
    `https://hn.algolia.com/api/v1/search_by_date?${query}`,
  );
  return hits.map((h) => ({
    key: `${name}:${h.objectID}`,
    source: name,
    kind: "hackernews",
    channel: "Hacker News",
    stream: h.objectID,
    ts: String(h.created_at_i),
    time: new Date(h.created_at_i * 1000).toISOString(),
    author: h.author,
    text: `${h.title} (${h.points} points, ${h.num_comments} comments)${h.url ? ` — ${h.url}` : ""}`,
    url: `https://news.ycombinator.com/item?id=${h.objectID}`,
  }));
}
