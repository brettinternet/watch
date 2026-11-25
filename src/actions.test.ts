import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actionRuns,
  type Item,
  itemKey,
  loudRuns,
  type Replies,
  recordReplies,
  replyTarget,
} from "./actions";
import { Config } from "./config";
import { readState, type Signal } from "./signal";

const sig = (kind: string, channel: string, ts: string, thread?: string): Signal => ({
  key: `acme:${channel}:${ts}`,
  source: "acme",
  kind,
  channel,
  ts,
  time: "",
  author: "Sam",
  text: "",
  ...(thread ? { thread } : {}),
});

test("an action's agent may write only to its item's Slack threads", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "watch-actions-"));
  mkdirSync(join(stateDir, "slack", "acme"), { recursive: true });
  writeFileSync(
    join(stateDir, "slack", "acme", "channels_cache_v2.json"),
    JSON.stringify([{ id: "C1", name: "#ops" }]),
  );
  const item = (signals: Signal[]): Item => ({
    priority: "high",
    category: "incident",
    reason: "",
    signals,
  });
  const reply = sig("slack", "#ops", "1700000002.000000", "1700000001.000000");
  const one = item([sig("github", "acme/api", "1"), sig("slack", "#unknown", "1"), reply]);
  recordReplies(stateDir, one, Date.now());
  const { targets } = readState<Replies>(join(stateDir, "replies.json"))[itemKey(one)]!;

  // The channel id from the cache, the thread root, and nothing from GitHub or unknown channels.
  expect(replyTarget(targets)).toMatchObject({ channel: "C1", thread: "1700000001.000000" });
  expect(() => replyTarget(targets, "acme:#general:1700000003.000000")).toThrow("must be one of");

  const two = item([reply, sig("slack", "#ops", "1700000005.000000")]);
  recordReplies(stateDir, two, Date.now());
  const both = readState<Replies>(join(stateDir, "replies.json"))[itemKey(two)]!.targets;
  expect(() => replyTarget(both)).toThrow("several threads");
  expect(replyTarget(both, reply.key).thread).toBe("1700000001.000000");

  // An item without Slack messages is still recorded, so its agent can settle its follow-ups.
  const pr = item([sig("github", "acme/api", "2")]);
  recordReplies(stateDir, pr, Date.now());
  const record = readState<Replies>(join(stateDir, "replies.json"))[itemKey(pr)]!;
  expect(record.keys).toEqual(["acme:acme/api:2"]);
  expect(() => replyTarget(record.targets)).toThrow("no Slack messages");
});

test("a command action forces a notification only for items its signal filter matches", () => {
  const { actions } = Config.parse({
    version: 1,
    llm: {},
    categories: { fyi: "x" },
    notify: {},
    actions: {
      deploy: {
        when: {
          sources: ["slack/acme"],
          min_priority: "low",
          channels: ["#deploys"],
          to: ["me"],
          bot: true,
          text: "please verify|now on staging",
        },
        run: "true",
      },
    },
  });
  const low = (s: Partial<Signal>): Item => ({
    priority: "low",
    category: "fyi",
    reason: "",
    signals: [{ ...sig("slack", "#deploys", "1"), ...s }],
  });
  const loud = (item: Item) => loudRuns(actionRuns(actions, [item], Date.now())).length > 0;

  expect(loud(low({ to: "me", bot: true, text: "PR #1 is now on Staging" }))).toBe(true);
  expect(loud(low({ channel: "#general", to: "others", text: "invite?" }))).toBe(false);
  expect(loud(low({ to: "me", text: "please verify" }))).toBe(false); // not a bot
  expect(loud(low({ to: "me", bot: true, text: "deploy failed" }))).toBe(false);
});
