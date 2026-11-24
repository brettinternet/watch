import { expect, test } from "bun:test";
import type { Item } from "./actions";
import { Config } from "./config";
import * as F from "./followups";
import type { Evidence, Followups } from "./followups";
import type { Signal } from "./signal";
import type { Mine } from "./sources/slack";

const work: Config["work_hours"] = { days: ["mon", "tue", "wed", "thu", "fri"], start: 8, end: 18 };
const at = (day: number, hour: number) => new Date(2026, 10, day, hour).getTime(); // Nov 2026, local
const ts = (ms: number) => (ms / 1000).toFixed(6);

const slack = (text: string, ms: number, extra: Partial<Signal> = {}): Signal => ({
  key: `acme:@sam:${ts(ms)}`,
  source: "acme",
  kind: "slack",
  channel: "@sam",
  ts: ts(ms),
  time: new Date(ms).toISOString(),
  author: "Sam",
  text,
  to: "dm",
  ...extra,
});
const review = (n: number, ms: number): Signal => ({
  key: `work:acme/api:#${n}:review:${ms}`,
  source: "work",
  kind: "github",
  channel: "acme/api",
  stream: `acme/api#${n}:review`,
  ts: ts(ms),
  time: new Date(ms).toISOString(),
  author: "pat",
  text: `Review requested: PR ${n}`,
});
/** What a run saw at `now`; `mine` undefined means the Slack session failed to open. */
const evidence = (
  now: number,
  signals: Signal[],
  mine: Mine[] | undefined,
  ran = ["slack/acme"],
): Evidence => ({
  ran: new Set(ran),
  signals,
  now,
  slack: new Map(mine ? [["acme", { mine, maxChannels: 30, maxMessages: 10 }]] : []),
});
const item = (signals: Signal[], priority: Item["priority"], category: string): Item => ({
  priority,
  category,
  reason: signals.at(-1)!.text,
  signals,
});
const settings = Config.shape.followups.parse({});
const opts = (now: number, notified = true, signals: Signal[] = []) =>
  ({ notified, minPriority: "normal", now, work, first: settings.first, signals }) as const;
const track = F.track;
const update = (l: Followups, ev: Evidence, cfg = settings) => F.update(l, ev, cfg);
const due = (l: Followups, ev: Evidence, fresh: Signal[]) =>
  F.due(l, ev, fresh, settings.reminders);
const remind = (l: Followups, ids: string[], now: number) =>
  F.remind(l, ids, now, work, settings.again);
const open = (l: Followups) => Object.values(l).filter((x) => !x.closed);
const reason = (l: Followups) => Object.values(l)[0]!.closed?.reason;

test("a notified ask reminds on the work-hours clock twice while unread, once after I read it", () => {
  const asked = at(20, 17); // Friday 17:00
  const ask = slack("can you approve the rollout?", asked);
  let ledger = track({}, [item([ask], "normal", "request")], [ask], opts(asked));
  const unread = (now: number) => evidence(now, [ask], []);

  // Four work hours from Friday 17:00 is Monday 11:00.
  expect(due(ledger, unread(at(23, 10)), [])).toEqual([]);
  const first = due(ledger, unread(at(23, 11)), []);
  expect(first.map(([, l]) => l.ask)).toEqual(["Sam · @sam: can you approve the rollout?"]);

  ledger = remind(ledger, [first[0]![0]], at(23, 11));
  expect(due(ledger, unread(at(23, 17)), [])).toEqual([]);
  // Twelve work hours on is Tuesday 13:00. Without a digest, a read ask then expires.
  const noDigest = { ...settings, digest: false as const };
  expect(due(ledger, unread(at(24, 12)), [])).toEqual([]);
  expect(reason(update(ledger, evidence(at(24, 13), [], []), noDigest))).toBe("expired");
  ledger = remind(ledger, [first[0]![0]], at(24, 13));
  expect(open(update(ledger, unread(at(25, 15))))).toHaveLength(1); // the digest keeps it
  ledger = update(ledger, unread(at(25, 15)), noDigest); // Wednesday 15:00, next due
  expect(open(ledger)).toEqual([]);
  expect(reason(ledger)).toBe("expired");
});

test("a Slack ask closes on my later reply in its conversation, not an earlier or unrelated one", () => {
  const asked = at(23, 9);
  const later = at(23, 15);
  const ask = slack("thoughts on the plan?", asked, {
    channel: "#ops",
    thread: ts(asked - 60_000),
    to: "me",
  });
  const ledger = track({}, [item([ask], "normal", "request")], [ask], opts(asked));
  const reply = (ms: number, thread?: string): Mine => ({
    channel: "#ops",
    ts: ts(ms),
    ...(thread ? { thread } : {}),
  });

  // Earlier, top-level, and other-thread messages don't answer a channel thread.
  const stale = [reply(asked - 1000, ask.thread), reply(asked + 1000), reply(asked + 1000, "1.0")];
  expect(open(update(ledger, evidence(later, [], stale)))).toHaveLength(1);
  // A Slack session that failed to open can't tell, so the loop neither closes nor reminds.
  expect(open(update(ledger, evidence(later, [], undefined)))).toHaveLength(1);
  expect(due(ledger, evidence(later, [], undefined), [])).toEqual([]);

  const answered = update(ledger, evidence(later, [], [reply(asked + 1000, ask.thread)]));
  expect(reason(answered)).toBe("replied in Slack");
});

test("a loop with one uncheckable anchor doesn't remind", () => {
  const asked = at(23, 9);
  const dm = slack("can you review #7?", asked);
  const pr = review(7, asked);
  const ledger = track({}, [item([dm, pr], "normal", "review")], [dm, pr], opts(asked));

  expect(due(ledger, evidence(at(23, 15), [dm, pr], [], ["slack/acme"]), [])).toEqual([]);
  const both = evidence(at(23, 15), [dm, pr], [], ["slack/acme", "github/work"]);
  expect(due(ledger, both, [])).toHaveLength(1);
});

test("a GitHub review request closes only when its source ran and no longer lists it", () => {
  const asked = at(23, 9);
  const later = at(23, 15);
  const pr = review(7, asked);
  const generic = { ...item([pr], "normal", "review"), reason: "A PR needs my review." };
  const ledger = track({}, [generic], [pr], opts(asked));
  // The PR's own number and title, not the LLM's reason, which can read the same for every PR.
  expect(open(ledger).map((l) => l.ask)).toEqual(["pat · acme/api#7: Review requested: PR 7"]);

  expect(open(update(ledger, evidence(later, [], undefined, [])))).toHaveLength(1); // gh failed
  const stillRequested = evidence(later, [review(7, asked)], undefined, ["github/work"]);
  expect(open(update(ledger, stillRequested))).toHaveLength(1);
  const gone = update(ledger, evidence(later, [], undefined, ["github/work"]));
  expect(reason(gone)).toBe("reviewed or no longer requested");
});

test("a direct message the LLM rated low reminds quietly only while known unread", () => {
  const asked = at(23, 9);
  const later = at(23, 13);
  const dm = slack("got a sec?", asked);
  const ledger = track({}, [item([dm], "none", "noise")], [dm], opts(asked, false));
  expect(open(ledger)).toMatchObject([{ silent: true, priority: "low" }]);

  expect(due(ledger, evidence(later, [dm], []), []).length).toBe(1); // still unread
  expect(reason(update(ledger, evidence(later, [], [])))).toBe("read without reply");

  // When the unread scan hit its channel cap, a missing message may just be unscanned.
  const busy = Array.from({ length: 30 }, (_, i) =>
    slack("hi", asked + 1000, { channel: `@u${i}`, key: `acme:@u${i}:x` }),
  );
  const cut = update(ledger, evidence(later, busy, []));
  expect(open(cut)).toHaveLength(1);
  expect(due(cut, evidence(later, busy, []), [])).toEqual([]);

  // Bots don't get a safety net.
  const bot = slack("your build passed", asked, { bot: true });
  expect(track({}, [item([bot], "none", "noise")], [bot], opts(asked, false))).toEqual({});
});

test("a later top-level message answers a DM but not a channel ask", () => {
  const asked = at(23, 9);
  const top = { ts: ts(asked + 1000) };
  const dm = slack("lunch?", asked);
  const post = slack("@me can you look?", asked, { channel: "#ops", to: "me" });
  const loop = (s: Signal) => track({}, [item([s], "normal", "request")], [s], opts(asked));

  expect(reason(update(loop(dm), evidence(at(23, 10), [], [{ channel: "@sam", ...top }])))).toBe(
    "replied in Slack",
  );
  expect(
    open(update(loop(post), evidence(at(23, 10), [], [{ channel: "#ops", ...top }]))),
  ).toHaveLength(1);
});

test("a Slack ask about a requested review is one loop, closed by the review, not a reply", () => {
  const asked = at(23, 9);
  const pr = review(7, asked - 3_600_000);
  const url = "<https://github.com/acme/api/pull/7|acme/api#7>";
  const ask = slack(`can you review ${url}?`, asked);
  const reply: Mine = { channel: "@sam", ts: ts(asked + 1000) };

  // The review request opened a loop an hour ago; Sam's ask about the same PR replaces it.
  let ledger = track({}, [item([pr], "normal", "review")], [pr], opts(asked - 3_600_000));
  ledger = track(ledger, [item([ask], "normal", "request")], [ask], opts(asked, true, [pr]));
  expect(open(ledger).map((l) => l.ask)).toEqual([`Sam · @sam: can you review ${url}?`]);

  const ran = ["slack/acme", "github/work"];
  expect(open(update(ledger, evidence(at(23, 15), [pr], [reply], ran)))).toHaveLength(1);
  const reviewed = update(ledger, evidence(at(23, 15), [], [reply], ran));
  expect(open(reviewed)).toEqual([]);
  expect(Object.values(reviewed).at(-1)!.closed?.reason).toBe("reviewed or no longer requested");

  // A PR no source reported isn't linked, so its absence can't close the ask.
  const other = track({}, [item([ask], "normal", "request")], [ask], opts(asked));
  expect(open(update(other, evidence(at(23, 15), [], [], ran)))).toHaveLength(1);
});

test("a new ask in the same thread replaces its loop, but a silent one never does", () => {
  const asked = at(23, 9);
  const root = ts(asked - 60_000);
  const first = slack("review this?", asked, { channel: "#ops", thread: root, to: "me" });
  const later = slack("ping?", asked + 3_600_000, { channel: "#ops", thread: root, to: "me" });
  const ledger = track({}, [item([first], "normal", "request")], [first], opts(asked));

  const quiet = track(ledger, [item([later], "low", "fyi")], [later], opts(asked, false));
  expect(open(quiet).map((l) => l.ask)).toEqual(["Sam · #ops: review this?"]);

  const loud = track(ledger, [item([later], "normal", "request")], [later], opts(asked));
  expect(open(loud).map((l) => l.ask)).toEqual(["Sam · #ops: ping?"]);
  expect(Object.values(loud).find((l) => l.closed)?.closed?.reason).toStartWith("superseded");
});

test("with reminders off, a digest lists what still waits and keeps it open until handled", () => {
  const asked = at(23, 9);
  const later = at(24, 9);
  const dm = slack("can you approve the rollout?", asked);
  const quiet = slack("got a sec?", asked, { channel: "@kim", key: "acme:@kim:1" });
  const cfg = Config.shape.followups.parse({ reminders: 0 });
  const opened = { ...opts(asked), first: cfg.first };
  const ledger = track({}, [item([dm], "normal", "request")], [dm, quiet], opened);
  const unread = evidence(later, [dm, quiet], []);

  expect(F.due(ledger, unread, [], cfg.reminders)).toEqual([]);
  expect(F.digest(ledger, evidence(at(23, 12), [dm, quiet], []))).toEqual([]); // not 4h yet
  // A silent loop is listed only while unread; the loud one regardless.
  const listed = (ev: Evidence) => F.digest(ledger, ev).map(([, l]) => l.silent ?? false);
  expect(listed(unread)).toEqual([false, true]);
  expect(listed(evidence(later, [], []))).toEqual([false]);
  // Days later, past where two reminders would have expired it, the loud loop is still open.
  const friday = update(ledger, evidence(at(27, 17), [dm], []), cfg);
  expect(open(friday).map((l) => l.ask)).toEqual(["Sam · @sam: can you approve the rollout?"]);
});
