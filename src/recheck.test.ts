import { expect, test } from "bun:test";
import { conversation } from "./recheck";
import type { Signal } from "./signal";

const msg = (ts: string, extra: Partial<Signal> = {}): Signal => ({
  key: `acme:#ops:${ts}`,
  source: "acme",
  kind: "slack",
  channel: "#ops",
  ts,
  time: "",
  author: "Kim",
  text: ts,
  ...extra,
});

test("a recheck reads only the ask's own conversation, never unrelated channel chatter", () => {
  const root = msg("100.0");
  const ask = msg("110.0", { thread: "100.0", to: "me" });
  const reply = msg("120.0", { thread: "100.0" });
  const chatter = [msg("130.0"), msg("140.0", { thread: "130.0" }), msg("90.0")];
  const found = [...chatter, reply, ask, root, reply];

  // A thread ask sees its thread from the root, in order and once each.
  expect(conversation(ask, found).map((s) => s.ts)).toEqual(["100.0", "110.0", "120.0"]);
  // A channel ask with no thread sees only replies to it.
  const top = msg("130.0", { to: "me" });
  expect(conversation(top, found).map((s) => s.ts)).toEqual(["130.0", "140.0"]);
  // A DM ask sees the top-level conversation after it.
  const dm = { ...msg("100.0", { channel: "@kim", to: "dm" }) };
  const dms = ["90.0", "100.0", "120.0"].map((ts) => msg(ts, { channel: "@kim" }));
  expect(
    conversation(dm, [...dms, msg("110.0", { channel: "@kim", thread: "90.0" })]).map((s) => s.ts),
  ).toEqual(["100.0", "120.0"]);
});
