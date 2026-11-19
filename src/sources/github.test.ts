import { expect, test } from "bun:test";
import { prsToSignals } from "./github";

test("a merged PR keeps a stable key and an exact merge timestamp", () => {
  const [s] = prsToSignals("work", "acme/api", [
    {
      number: 812,
      title: "Fix checkout retry",
      url: "https://github.com/acme/api/pull/812",
      mergedAt: "2026-11-19T16:57:30.500Z",
      author: { login: "sam" },
    },
  ]);
  expect(s).toEqual({
    key: "work:acme/api:#812",
    source: "work",
    kind: "github",
    channel: "acme/api",
    ts: "1795107450.500",
    time: "2026-11-19T16:57:30.500Z",
    author: "sam",
    text: "Fix checkout retry — https://github.com/acme/api/pull/812",
  });
});

test("open PRs returned by a wide search are dropped", () => {
  const prs = [{ number: 1, title: "wip", url: "u", mergedAt: "", author: null }];
  expect(prsToSignals("work", "acme/api", prs)).toEqual([]);
});
