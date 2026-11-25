import { expect, test } from "bun:test";
import { Config } from "./config";
import type { Signal } from "./signal";
import { lookups } from "./verify";

test("look-ups stay within configured sources and the items worth a second pass", () => {
  const cfg = Config.parse({
    version: 1,
    llm: {},
    categories: { request: "x" },
    notify: {},
    sources: { github: { work: { repos: ["Acme/API"] } }, linear: { acme: {} } },
  });
  const msg = (kind: string, text: string): Signal => ({
    key: text,
    source: "acme",
    kind,
    channel: "#ops",
    ts: "1",
    time: "",
    author: "Sam",
    text,
  });
  const fresh = [
    msg("slack", "can you review acme/api#7?"),
    msg("github", "Merged: x"),
    msg("slack", "<https://github.com/acme/api/pull/9|#9> and evil/repo#2 merged, and #10?"),
  ];
  const item = (ids: string[], priority: "low" | "normal", verify: string[]) => ({
    ids,
    priority,
    category: "request",
    reason: "",
    verify,
  });
  const first = {
    title: "",
    summary: "",
    items: [
      item(["m1"], "normal", [
        "thread",
        "evil/repo#1",
        "acme/api#7",
        "https://x.test",
        "ENG-4",
        "ENG-5",
      ]),
      item(["m2"], "normal", ["thread"]), // no Slack message to read the thread of
      // Linked PRs are looked up without being asked for, once, in configured repos only.
      item(["m3"], "normal", ["Acme/API#9"]),
      item(["m1"], "low", ["acme/api#8"]), // below the threshold
    ],
  };

  expect(lookups(cfg, fresh, first, "normal")).toEqual([
    { what: "thread", for: "m1", signal: fresh[0]! },
    { what: "pr", for: "m1", source: "work", repo: "Acme/API", n: 7 },
    { what: "issue", for: "m1", sources: ["acme"], issue: "ENG-4" },
    { what: "pr", for: "m3", source: "work", repo: "Acme/API", n: 9 },
  ]);
});
