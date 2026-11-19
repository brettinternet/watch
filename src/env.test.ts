import { expect, test } from "bun:test";
import { actionEnv } from "./actions";
import { serverEnv } from "./sources/slack";

const env = {
  PATH: "/bin",
  HOME: "/home/me",
  SLACK_ACME_XOXC_TOKEN: "xoxc-acme",
  SLACK_ACME_XOXD_TOKEN: "xoxd-acme",
  SLACK_ACMEX_XOXC_TOKEN: "xoxc-acmex",
  SLACK_OTHER_XOXP_TOKEN: "xoxp-other",
  PUSHOVER_TOKEN: "pushover",
  NOON_EVENT_FILE: "/tmp/event",
};

test("a workspace's MCP server sees only that workspace's tokens", () => {
  const out = serverEnv("acme", env, "/cache");
  expect(out.SLACK_MCP_XOXC_TOKEN).toBe("xoxc-acme");
  expect(out.SLACK_MCP_XOXD_TOKEN).toBe("xoxd-acme");
  for (const secret of ["xoxc-acmex", "xoxp-other", "pushover"])
    expect(Object.values(out)).not.toContain(secret);
  expect(() => serverEnv("missing", env, "/cache")).toThrow("SLACK_MISSING_XOXC_TOKEN");
});

test("actions get no secrets or parent Noon context", () => {
  const item = { priority: "high" as const, category: "incident", reason: "Outage", signals: [] };
  expect(Object.keys(actionEnv(env, "investigate", item)).sort()).toEqual([
    "HOME",
    "PATH",
    "TRIAGE_ACTION",
    "TRIAGE_CATEGORY",
    "TRIAGE_KEY",
    "TRIAGE_PRIORITY",
  ]);
});
