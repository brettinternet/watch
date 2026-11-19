import { expect, test } from "bun:test";
import { actionEnv } from "./actions";
import { serverEnv } from "./sources/slack";

const env = {
  PATH: "/bin",
  HOME: "/home/me",
  SLACK_ACME_XOXC_TOKEN: "xoxc-acme",
  SLACK_ACME_XOXD_TOKEN: "xoxd-acme",
  SLACK_ACME_USER_AGENT: "Slack/4",
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

test("xoxc/xoxd without the app's User-Agent is refused (Enterprise Grid signs the user out)", () => {
  const { SLACK_ACME_USER_AGENT: _, ...noAgent } = env;
  expect(() => serverEnv("acme", noAgent, "/cache")).toThrow("task setup:slack -- acme");
  expect(serverEnv("other", env, "/cache").SLACK_MCP_XOXP_TOKEN).toBe("xoxp-other");
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
