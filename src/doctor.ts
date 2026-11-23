/**
 * Read-only setup and state checks: `task doctor`. Prints one `ok|warn|fail name: detail` line
 * per check, then Tell's and Noon's own doctors and recent runs. Exits 1 if any check fails.
 * Never prints secrets. Only xoxp gets a live Slack check; desktop-session tokens are not
 * requested through Bun's differently fingerprinted HTTP/TLS client.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Config, loadConfig, sourceIds } from "./config";
import { jiraAuth, jiraGet } from "./sources/jira";
import { linearKey, linearQuery } from "./sources/linear";
import { readChannels, readUsers, serverEnv } from "./sources/slack";
import { trafficEvents } from "./sources/traffic";

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
    return report("fail", `slack/${name}`, (e as Error).message);
  }
  const xoxp = env.SLACK_MCP_XOXP_TOKEN;
  // Bun's fetch cannot reproduce slack-mcp-server's custom TLS fingerprint. Don't risk session
  // revocation with a differently fingerprinted live check for desktop-session credentials.
  if (!xoxp)
    return report(
      "warn",
      `slack/${name}`,
      "xoxc/xoxd not live-tested; auth.test cannot use slack-mcp-server's custom TLS",
    );
  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${xoxp}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as {
      ok: boolean;
      error?: string;
      user?: string;
      team?: string;
    };
    if (body.ok) report("ok", `slack/${name}`, `${body.user} @ ${body.team}`);
    else report("fail", `slack/${name}`, `${body.error}; re-run: task setup:slack -- ${name}`);
  } catch (e) {
    report("fail", `slack/${name}`, `auth.test: ${(e as Error).message}`);
  }
}

/** A read-only identity request with the source's own credentials. */
async function whoami(label: string, check: () => Promise<string>) {
  try {
    report("ok", label, await check());
  } catch (e) {
    report("fail", label, (e as Error).message);
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
  const names = sourceIds(cfg);
  if (names.length) report("ok", "config", `llm ${cfg.llm.agent}; sources ${names.join(", ")}`);
  else report("fail", "config", "no sources; add one to triage.local.yaml");
} catch (e) {
  report("fail", "config", (e as Error).message);
}

const sources = cfg?.sources;
const tools = ["tell", "noon"];
if (cfg) tools.push(cfg.llm.agent === "command" ? cfg.llm.command![0]! : cfg.llm.agent);
if (Object.keys(sources?.slack ?? {}).length) tools.push("slack-mcp-server");
const usesGh = Object.keys({ ...sources?.github, ...sources?.dependabot }).length > 0;
if (usesGh) tools.push("gh");
const missing = tools.filter((t) => !Bun.which(t));
if (missing.length) report("fail", "tools", `not on PATH: ${missing.join(", ")}`);
else report("ok", "tools", tools.join(", "));

await Promise.all([
  ...Object.keys(sources?.slack ?? {}).map(slackAuth),
  ...Object.keys(sources?.linear ?? {}).map((name) =>
    whoami(`linear/${name}`, async () => {
      const { viewer } = await linearQuery<{ viewer: { name: string } }>(
        linearKey(name, process.env),
        "{ viewer { name } }",
      );
      return viewer.name;
    }),
  ),
  ...Object.entries(sources?.jira ?? {}).map(([name, s]) =>
    whoami(`jira/${name}`, async () => {
      const auth = jiraAuth(name, process.env);
      const me = await jiraGet<{ displayName: string }>(s, auth, "/rest/api/2/myself");
      return `${me.displayName} @ ${s.url}`;
    }),
  ),
  ...Object.entries(sources?.traffic ?? {}).map(([name, s]) =>
    whoami(`traffic/${name}`, async () => {
      const events = await trafficEvents(name, s, process.env);
      return `${events.length} events @ ${s.url}`;
    }),
  ),
]);
if (usesGh) {
  const gh = run(["gh", "auth", "status"]);
  if (gh.code === 0) report("ok", "gh", "authenticated");
  else report("fail", "gh", gh.out.split("\n")[0] ?? `exit ${gh.code}`);
}

// VIPs and priority channels, checked against the Slack caches the last run synced
const slackCache = (name: string) => join(root, ".state", "slack", name);
const slackNames = Object.keys(sources?.slack ?? {});
const vips = Object.keys(cfg?.vips ?? {});
if (vips.length && slackNames.length) {
  const emails = new Set(
    slackNames.flatMap((n) => [...readUsers(slackCache(n)).values()].flatMap((u) => u.email ?? [])),
  );
  const unknown = vips.filter((e) => !emails.has(e));
  if (!emails.size)
    report("warn", "vips", "not checked; no Slack users cache before the first run");
  else if (unknown.length)
    report(
      "warn",
      "vips",
      `not in any Slack workspace (typo, or Linear/Jira only): ${unknown.join(", ")}`,
    );
  else report("ok", "vips", `${vips.length} found in Slack`);
}
for (const name of slackNames) {
  const wanted = Object.keys(sources!.slack[name]!.priority_channels);
  if (!wanted.length) continue;
  const label = `slack/${name} priority_channels`;
  const known = new Set(readChannels(slackCache(name)).map((c) => c.name.replace(/^#/, "")));
  const unknown = wanted.filter((c) => !known.has(c));
  if (!known.size) report("warn", label, "not checked; no channel cache before the first run");
  else if (unknown.length) report("warn", label, `unknown: ${unknown.join(", ")}`);
  else report("ok", label, wanted.join(", "));
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
