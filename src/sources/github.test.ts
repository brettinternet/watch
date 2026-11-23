import { expect, test } from "bun:test";
import { type OpenPr, prsToSignals, readyPrsToSignals } from "./github";

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
    text: "Merged: Fix checkout retry — https://github.com/acme/api/pull/812",
    url: "https://github.com/acme/api/pull/812",
  });
});

test("open PRs returned by a wide search are dropped", () => {
  const prs = [{ number: 1, title: "wip", url: "u", mergedAt: "", author: null }];
  expect(prsToSignals("work", "acme/api", prs)).toEqual([]);
});

test("a ready PR keys on its latest approval or check, ignoring comments and unready PRs", () => {
  const pr = (number: number, mergeStateStatus: string): OpenPr => ({
    number,
    title: "Add retries",
    url: `https://github.com/acme/api/pull/${number}`,
    createdAt: "2026-11-18T09:00:00Z",
    author: { login: "sam" },
    mergeStateStatus,
    latestReviews: [
      { state: "APPROVED", submittedAt: "2026-11-19T10:00:00Z" },
      { state: "COMMENTED", submittedAt: "2026-11-19T12:00:00Z" },
    ],
    statusCheckRollup: [
      { completedAt: "2026-11-19T11:00:00Z" },
      { startedAt: "2026-11-19T09:30:00Z" },
    ],
  });
  const signals = readyPrsToSignals("work", "acme/api", [
    pr(1, "CLEAN"),
    pr(2, "BLOCKED"),
    pr(3, "BEHIND"),
    pr(4, "UNSTABLE"),
    pr(5, "DRAFT"),
    pr(6, "UNKNOWN"),
  ]);
  expect(signals.map((s) => [s.stream, s.time])).toEqual([
    ["acme/api#1:ready", "2026-11-19T11:00:00.000Z"],
  ]);
});
