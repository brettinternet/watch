import { expect, test } from "bun:test";
import { advance, compareTs, prune, type Signal, unseen } from "./signal";

const sig = (channel: string, ts: string): Signal => ({
  key: `acme:${channel}:${ts}`,
  source: "acme",
  kind: "slack",
  channel,
  ts,
  time: "",
  author: "",
  text: "",
});

test("compareTs orders decimal timestamps exactly", () => {
  expect(compareTs("999999999.9", "1000000000.0")).toBeLessThan(0);
  expect(compareTs("1700000000.5", "1700000000.40")).toBeGreaterThan(0);
  expect(compareTs("1700000000.000100", "1700000000.0001")).toBe(0);
});

test("each message is handed to exactly one run", () => {
  const first = [
    sig("#a", "1700000000.000100"),
    sig("#a", "1700000000.000200"),
    sig("#b", "1700000000.000050"),
  ];
  const cursors = advance({}, unseen(first, {}, "0"));

  // Slack still reports the old unreads next time, plus one new message.
  const next = [...first, sig("#a", "1700000000.000300")];
  expect(unseen(next, cursors, "0").map((s) => s.key)).toEqual(["acme:#a:1700000000.000300"]);
  expect(unseen([sig("#c", "1600000000.000000")], cursors, "1700000000")).toEqual([]);
});

test("a thread mention found late by search is not hidden by its channel's cursor", () => {
  const cursors = advance({}, [sig("#a", "1700000000.000300")]);
  const reply = { ...sig("#a", "1700000000.000200"), stream: "thread-mentions" };
  expect(unseen([reply], cursors, "0")).toEqual([reply]);
  expect(unseen([reply], advance(cursors, [reply]), "0")).toEqual([]);
});

test("pruning cursors older than the age limit never resurfaces a handled signal", () => {
  const minTs = "1700000000";
  const handled = [sig("#old", "1699999999.000000"), sig("#new", "1700000001.000000")];
  const pruned = prune(advance({}, handled), minTs);
  expect(pruned).toEqual({ "slack/acme": { "#new": "1700000001.000000" } });
  expect(unseen(handled, pruned, minTs)).toEqual([]);
});

test("sources sharing a name across kinds keep separate cursors", () => {
  const linear = { ...sig("ENG-7", "1700000000.000200"), kind: "linear" };
  const jira = { ...sig("ENG-7", "1700000000.000100"), kind: "jira" };
  expect(unseen([jira], advance({}, [linear]), "0")).toEqual([jira]);
});
