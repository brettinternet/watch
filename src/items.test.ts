import { expect, test } from "bun:test";
import { Config } from "./config";
import { floorOf, toItems } from "./items";
import type { Triage } from "./llm";
import type { Signal } from "./signal";

const sig = (channel: string, author: string, text: string, email?: string): Signal => ({
  key: `acme:${channel}:${text}`,
  source: "acme",
  kind: "slack",
  channel,
  ts: "1700000000.000100",
  time: "",
  author,
  text,
  ...(email ? { email } : {}),
});

test("VIPs and priority channels match regardless of case or #", () => {
  const cfg = Config.parse({
    version: 1,
    llm: {},
    categories: { fyi: "x" },
    notify: {},
    vips: { "Sam@Acme.com": "high", "pat@acme.com": null },
    sources: { slack: { acme: { priority_channels: { "#ops": "low" } } } },
  });
  expect(floorOf(cfg, sig("#ops", "Sam", "hi", "sam@ACME.com"))).toBe("high");
  expect(floorOf(cfg, sig("#ops", "Ana", "hi"))).toBe("low");
  expect(floorOf(cfg, sig("#dev", "Pat", "hi", "pat@acme.com"))).toBe("normal");
  expect(floorOf(cfg, sig("#dev", "Ana", "hi", "ana@acme.com"))).toBeUndefined();
});

test("a VIP message the LLM rates none or skips still notifies and is summarized", () => {
  const signals = [
    { ...sig("#dev", "Ana", "PR ready"), floor: undefined },
    { ...sig("#random", "Sam", "lunch?", "sam@acme.com"), floor: "high" as const },
    { ...sig("#ops", "Sam", "call me now", "sam@acme.com"), floor: "high" as const },
  ];
  const t: Triage = {
    title: "Ana's PR",
    summary: "Ana · #dev: PR ready → review",
    items: [
      { ids: ["m1"], priority: "normal", category: "review", reason: "Review PR" },
      { ids: ["m2"], priority: "none", category: "fyi", reason: "Lunch chatter" },
    ],
  };
  const { title, summary, items } = toItems(t, signals);
  expect(items.map((i) => [i.priority, i.signals.map((s) => s.channel)])).toEqual([
    ["normal", ["#dev"]],
    ["high", ["#random"]], // rated none, raised
    ["high", ["#ops"]], // skipped by the LLM
  ]);
  expect(title).toBe("Sam · #random: Lunch chatter");
  expect(summary).toBe(
    "• Sam · #random: Lunch chatter\n• Sam · #ops: call me now\n• Ana · #dev: PR ready → review",
  );
});

test("floored items the LLM already summarized keep its title and summary", () => {
  const signals = [{ ...sig("#ops", "Sam", "deploy?"), floor: "normal" as const }];
  const t: Triage = {
    title: "Sam asks about deploy",
    summary: "Sam · #ops: deploy? → reply",
    items: [{ ids: ["m1"], priority: "low", category: "fyi", reason: "Deploy question" }],
  };
  expect(toItems(t, signals)).toEqual({
    title: t.title,
    summary: t.summary,
    items: [{ priority: "normal", category: "fyi", reason: "Deploy question", signals }],
  });
});
