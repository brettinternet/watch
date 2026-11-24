import { expect, test } from "bun:test";
import { readUpTo } from "./builtins";
import type { Signal } from "./signal";
import { THREAD_STREAM } from "./sources/slack";

const sig = (channel: string, ts: string, stream?: string): Signal => ({
  key: `acme:${channel}:${ts}`,
  source: "acme",
  kind: "slack",
  channel,
  ts,
  time: "",
  author: "Sam",
  text: "",
  ...(stream ? { stream } : {}),
});

test("mark_read never hides an unread message it isn't clearing", () => {
  const all = [
    sig("#ops", "3"),
    sig("#ops", "1"),
    sig("#ops", "2"), // a request, kept
    sig("#news", "1"),
    sig("#news", "2"),
    sig("#big", "1"),
    sig("#ops", "4", THREAD_STREAM),
  ];
  const cleared = new Set(
    ["#ops:1", "#ops:3", "#ops:4", "#news:1", "#news:2", "#big:1"].map((k) => `acme:${k}`),
  );
  const marks = readUpTo(all, cleared, (_, channel) => channel !== "#big");
  expect(marks).toEqual([
    { source: "acme", channel: "#ops", ts: "1" },
    { source: "acme", channel: "#news", ts: "2" },
  ]);
});
