/**
 * Read-only setup and state checks: `task doctor`. Prints one `ok|warn|fail name: detail` line
 * per check, then Tell's and Noon's own doctors and recent runs. Exits 1 if any check fails.
 * Never prints secrets: only whether they are set and what Slack says about them.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Config, loadConfig } from "./config";
import { serverEnv } from "./sources/slack";

const root = resolve(import.meta.dir, "..");
let failed = false;

function report(status: "ok" | "warn" | "fail", name: string, detail: string) {
  if (status === "fail") failed = true;
  console.log(`${status.padEnd(4)} ${name}: ${detail}`);
}

function run(argv: string[]) {
  const p = Bun.spawnSync(argv, { cwd: root, stdin: "ignore" });
  return { code: p.exitCode, out: `${p.stdout}${p.stderr}`.trim() };
}

/** Runs another tool's doctor with its output passed through; a nonzero exit fails. */
function delegate(name: string, argv: string[]) {
  console.log(`\n# ${name}`);
  const p = Bun.spawnSync(argv, { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
  if (p.exitCode !== 0) report("fail", name, `${argv.join(" ")} exited ${p.exitCode}`);
}

const ago = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 120 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};

async function slackAuth(name: string) {
  let env: Record<string, string>;
  try {
    env = serverEnv(name, process.env, "");
  } catch (e) {
    return report("fail", `slack ${name}`, (e as Error).message);
  }
  const xoxp = env.SLACK_MCP_XOXP_TOKEN;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${xoxp ?? env.SLACK_MCP_XOXC_TOKEN}`,
  };
  if (!xoxp) headers.Cookie = `d=${env.SLACK_MCP_XOXD_TOKEN}`;
  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as {
      ok: boolean;
      error?: string;
      user?: string;
      team?: string;
    };
    if (body.ok) report("ok", `slack ${name}`, `${body.user} @ ${body.team}`);
    else report("fail", `slack ${name}`, `${body.error}; re-run: task setup:slack -- ${name}`);
  } catch (e) {
    report("fail", `slack ${name}`, `auth.test: ${(e as Error).message}`);
  }
}

// Checkout: scheduled jobs run only from the primary checkout.
const primary = dirname(
  run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]).out,
);
if (primary === root) report("ok", "checkout", root);
else report("warn", "checkout", `worktree; scheduled jobs run from ${primary}`);
const counts = run(["git", "rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
if (counts.code !== 0) report("warn", "upstream", "no upstream branch; the update job can't pull");
else {
  const [behind, ahead] = counts.out.split(/\s+/).map(Number);
  if (behind)
    report("warn", "upstream", `${behind} behind as of last fetch; the update job pulls hourly`);
  else report("ok", "upstream", ahead ? `${ahead} ahead` : "current as of last fetch");
}

// Per-clone files
if (existsSync(join(root, "triage.local.yaml"))) report("ok", "triage.local.yaml", "present");
else report("fail", "triage.local.yaml", "missing; run task setup:config");
const envMode = statSync(join(root, ".env.local")).mode & 0o777;
if (envMode & 0o077)
  report("warn", ".env.local", `mode ${envMode.toString(8)}; run chmod 600 .env.local`);
else report("ok", ".env.local", `mode ${envMode.toString(8)}`);
const tellYaml = join(primary, ".git", "tell.yaml");
if (existsSync(tellYaml)) report("ok", "tell.yaml", tellYaml);
else report("fail", "tell.yaml", "missing, so notifications go to stderr; run task setup:tell");

// Config, tools, and credentials
let cfg: Config | undefined;
try {
  cfg = loadConfig(root);
  const names = Object.keys(cfg.sources);
  if (names.length) report("ok", "config", `llm ${cfg.llm.agent}; sources ${names.join(", ")}`);
  else report("fail", "config", "no sources; add one to triage.local.yaml");
} catch (e) {
  report("fail", "config", (e as Error).message);
}

const kinds = new Set(Object.values(cfg?.sources ?? {}).map((s) => s.kind));
const tools = ["tell", "noon"];
if (cfg) tools.push(cfg.llm.agent === "command" ? cfg.llm.command![0]! : cfg.llm.agent);
if (kinds.has("slack")) tools.push("slack-mcp-server");
if (kinds.has("github")) tools.push("gh");
const missing = tools.filter((t) => !Bun.which(t));
if (missing.length) report("fail", "tools", `not on PATH: ${missing.join(", ")}`);
else report("ok", "tools", tools.join(", "));

const unset = ["PUSHOVER_TOKEN", "PUSHOVER_USER"].filter((k) => !process.env[k]);
if (unset.length) report("fail", "pushover", `set ${unset.join(", ")} in .env.local`);
else report("ok", "pushover", "credentials set");

await Promise.all(
  Object.entries(cfg?.sources ?? {}).flatMap(([name, s]) =>
    s.kind === "slack" ? [slackAuth(name)] : [],
  ),
);
if (kinds.has("github")) {
  const gh = run(["gh", "auth", "status"]);
  if (gh.code === 0) report("ok", "gh", "authenticated");
  else report("fail", "gh", gh.out.split("\n")[0] ?? `exit ${gh.code}`);
}

// State
const cursors = join(root, ".state", "cursors.json");
if (existsSync(cursors))
  report("ok", "cursors", `last advanced ${ago(Date.now() - statSync(cursors).mtimeMs)}`);
else report("warn", "cursors", "none yet; no run has handled messages");

delegate("tell", ["tell", "-C", root, "doctor"]);
delegate("noon", ["noon", "-C", root, "doctor"]);
console.log("\n# recent runs");
Bun.spawnSync(["noon", "-C", root, "history", "-n", "5"], {
  stdio: ["ignore", "inherit", "inherit"],
});

process.exit(failed ? 1 : 0);
