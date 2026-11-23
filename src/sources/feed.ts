import { XMLParser } from "fast-xml-parser";
import type { FeedSource } from "../config";
import type { Signal } from "../signal";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "#text",
  isArray: (tag) => tag === "item" || tag === "entry" || tag === "link",
});

type Node = string | number | { "#text"?: string | number; href?: string; rel?: string };
type Entry = Record<string, Node | Node[] | { name?: Node } | undefined>;

/** Text of an element that may carry attributes, e.g. <guid isPermaLink="false">. */
const text = (n: unknown): string =>
  typeof n === "string" || typeof n === "number"
    ? String(n).trim()
    : n && typeof n === "object" && "#text" in n
      ? String(n["#text"]).trim()
      : "";

/** RSS <link>url</link>, or Atom's alternate <link href>. */
function linkOf(e: Entry): string {
  const links = (e.link ?? []) as Node[];
  for (const l of links) if (typeof l === "string") return l.trim();
  const atom = links.find((l) => typeof l === "object" && (!l.rel || l.rel === "alternate"));
  return typeof atom === "object" ? (atom.href ?? "") : "";
}

/** New items in an RSS or Atom feed. */
export async function collectFeed(name: string, source: FeedSource): Promise<Signal[]> {
  const res = await fetch(source.url, {
    headers: { "User-Agent": "watch-triage" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GET ${source.url}: HTTP ${res.status}`);
  return feedToSignals(name, await res.text());
}

export function feedToSignals(name: string, xml: string): Signal[] {
  const doc = parser.parse(xml);
  const feed = doc.rss?.channel ?? doc.feed;
  if (!feed) throw new Error("not an RSS or Atom feed");
  const title = text(feed.title) || name;
  const entries: Entry[] = feed.item ?? feed.entry ?? [];
  return entries.flatMap((e) => {
    const when = Date.parse(text(e.pubDate ?? e.published ?? e.updated ?? e["dc:date"]));
    const url = linkOf(e);
    const id = text(e.guid ?? e.id) || url;
    if (Number.isNaN(when) || !id) return [];
    const author = e.author as { name?: Node } | Node | undefined;
    const body = text(e.description ?? e.summary ?? e.content).replace(/<[^>]*>/g, " ");
    return [
      {
        key: `${name}:${id}`,
        source: name,
        kind: "feed",
        channel: title,
        stream: "items", // the channel is the feed's title, which can change
        ts: (when / 1000).toFixed(3),
        time: new Date(when).toISOString(),
        author:
          text(typeof author === "object" && "name" in author ? author.name : author) ||
          text(e["dc:creator"]) ||
          title,
        text: [text(e.title), body.replace(/\s+/g, " ").trim()].filter(Boolean).join(" — "),
        ...(url ? { url } : {}),
      },
    ];
  });
}
