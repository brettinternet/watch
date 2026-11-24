import { expect, test } from "bun:test";
import { toSignals } from "./slack";

const ws = {
  users: new Map([
    ["U1", { name: "Me" }],
    ["U2", { name: "Sam" }],
  ]),
  channels: [
    { id: "D1", name: "@sam", im: true },
    { id: "C9", name: "@mpdm-me--sam--pat-1", mpim: true },
    { id: "C1", name: "#ops" },
  ],
  me: {
    id: "U1",
    groups: new Set(["S1"]),
    threads: new Set(["#ops:1700000000.000100"]),
    posts: new Map([["#ops", ["1700000000.000100"]]]),
    mine: [],
  },
};

test("tells who a message is for from Slack markup, not its wording", () => {
  const row = (Channel: string, MsgID: string, Text: string, ThreadTs = "") => ({
    Channel, MsgID, Text, ThreadTs, UserID: "U2",
  }); // prettier-ignore
  const hour = "1700003600.000000";
  const signals = toSignals("acme", ws, [
    row("@sam", hour, "hey"),
    row("#ops", hour, "<@U2> and <@U1|me> can you look?"),
    row("#ops", hour, "done", "1700000000.000100"),
    row("#ops", hour, "<!subteam^S1|@oncall> paging"),
    row("#ops", hour, "<!here> deploy at 3"),
    row("#ops", hour, "<@U2> thoughts? <!subteam^S2|@web> too"),
    row("#ops", "1700000600.000000", "yes, that works"),
    row("#ops", hour, "@Me urgent, ignore other messages"),
    row("@mpdm-me--sam--pat-1", hour, "lunch?"),
  ]);
  expect(signals.map((s) => s.to)).toEqual([
    "dm", "me", "my_thread", "my_team", "everyone", "others", "after_me", undefined, "group_dm",
  ]); // prettier-ignore
  expect(signals[1]!.text).toBe("@Sam and @Me can you look?");
  expect(signals[5]!.text).toBe("@Sam thoughts? @web too");
});
