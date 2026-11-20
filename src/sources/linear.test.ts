import { expect, test } from "bun:test";
import { type Notification, notificationsToSignals } from "./linear";

const issue = { identifier: "ENG-7", title: "Checkout retries", url: "https://linear.app/i/ENG-7" };
const comment = (extra = {}) => ({
  body: "can you take this?",
  url: "https://linear.app/i/ENG-7#c1",
  externalUser: null,
  botActor: null,
  syncedWith: null,
  ...extra,
});
const note = (id: string, extra: Partial<Notification> = {}): Notification => ({
  id,
  type: "issueCommentMention",
  category: "mentions",
  createdAt: "2026-11-19T16:57:30.500Z",
  readAt: null,
  snoozedUntilAt: null,
  actor: { name: "Sam" },
  botActor: null,
  externalUserActor: null,
  issue,
  comment: comment(),
  ...extra,
});

test("only unread asks from teammates pass; mirrors, bots, and noise are dropped", () => {
  const now = Date.parse("2026-11-20T00:00:00Z");
  const signals = notificationsToSignals(
    "work",
    [
      note("keep"),
      note("github-pr", { actor: null, botActor: { id: "github" }, comment: null }),
      note("github-comment", { actor: null, externalUserActor: { id: "x" } }),
      note("slack-synced", { comment: comment({ syncedWith: [{ service: "slack" }] }) }),
      note("status", { category: "statusChanges", type: "issueStatusChanged" }),
      note("read", { readAt: "2026-11-19T17:00:00Z" }),
      note("snoozed", { snoozedUntilAt: "2026-11-21T00:00:00Z" }),
    ],
    now,
  );
  expect(signals).toEqual([
    {
      key: "work:keep",
      source: "work",
      kind: "linear",
      channel: "ENG-7",
      ts: "1795107450.500",
      time: "2026-11-19T16:57:30.500Z",
      author: "Sam",
      text: "issueCommentMention: Checkout retries — can you take this?",
      url: "https://linear.app/i/ENG-7#c1",
    },
  ]);
});
