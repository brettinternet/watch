import { expect, test } from "bun:test";
import { feedToSignals } from "./feed";

test("RSS and Atom items keep their id, link, time, and text when elements carry attributes", () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Daily</title>
    <item><title>Big news</title><link>https://ex.com/a</link>
      <guid isPermaLink="false">a-1</guid><pubDate>Mon, 23 Nov 2026 15:00:00 GMT</pubDate>
      <description><![CDATA[<p>It <b>happened</b>.</p>]]></description></item>
    <item><title>Undated</title><link>https://ex.com/b</link></item>
  </channel></rss>`;
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <title type="text">Blog</title>
    <entry><title type="html">Post</title><id>urn:p1</id><updated>2026-11-23T16:00:00Z</updated>
      <link rel="self" href="https://ex.com/p1.atom"/><link href="https://ex.com/p1"/>
      <author><name>Ann</name></author></entry>
  </feed>`;

  expect(feedToSignals("news", rss)).toEqual([
    {
      key: "news:a-1",
      source: "news",
      kind: "feed",
      channel: "Daily",
      stream: "items",
      ts: "1795446000.000",
      time: "2026-11-23T15:00:00.000Z",
      author: "Daily",
      text: "Big news — It happened .",
      url: "https://ex.com/a",
    },
  ]);
  expect(feedToSignals("blog", atom)).toMatchObject([
    { key: "blog:urn:p1", channel: "Blog", author: "Ann", text: "Post", url: "https://ex.com/p1" },
  ]);
});
