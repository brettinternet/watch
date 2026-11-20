import { expect, test } from "bun:test";
import { type Issue, issuesToSignals } from "./jira";

const ME = "me-1";
const person = (accountId: string) => ({
  accountId,
  displayName: "Sam Lee",
  accountType: "atlassian",
});
const bot = { accountId: "auto", displayName: "Automation for Jira", accountType: "app" };
const at = "2026-11-19T16:57:30.500+0000";
const old = "2026-11-18T00:00:00.000+0000";

const issue = (
  key: string,
  assignee: string | null,
  comments: [string, typeof bot, string, string][],
): Issue => ({
  key,
  fields: {
    summary: `${key} summary`,
    assignee: assignee ? { accountId: assignee } : null,
    reporter: null,
    comment: {
      comments: comments.map(([id, author, body, created]) => ({ id, author, body, created })),
    },
  },
});

test("keeps people's comments on my issues or mentioning me, and assignments to me", () => {
  const watched = issue("OPS-2", "other", [
    ["21", person("sam"), `[~accountid:${ME}] thoughts?`, at],
    ["22", person("sam"), "unrelated chatter", at],
  ]);
  const mine = issue("OPS-1", ME, [
    ["11", person("sam"), "blocked on you", at],
    ["12", bot, "PR merged", at],
    ["13", person(ME), "my own reply", at],
    ["14", person("sam"), "before the window", old],
  ]);
  mine.changelog = {
    histories: [
      { id: "1", author: person("sam"), created: at, items: [{ field: "assignee", to: ME }] },
      { id: "2", author: person(ME), created: at, items: [{ field: "assignee", to: ME }] },
      { id: "3", author: bot, created: at, items: [{ field: "assignee", to: ME }] },
    ],
  };
  const signals = issuesToSignals(
    "work",
    "https://acme.atlassian.net/",
    ME,
    [mine, watched],
    "2026-11-19T00:00:00Z",
  );
  expect(signals.map((s) => [s.key, s.text])).toEqual([
    ["work:OPS-1:c11", "comment: OPS-1 summary — blocked on you"],
    ["work:OPS-1:a1", "assigned to me: OPS-1 summary"],
    ["work:OPS-2:c21", "comment: OPS-2 summary — @me thoughts?"],
  ]);
  expect(signals[0]).toMatchObject({
    ts: "1795107450.500",
    time: "2026-11-19T16:57:30.500Z",
    author: "Sam Lee",
    url: "https://acme.atlassian.net/browse/OPS-1?focusedCommentId=11",
  });
});
