/**
 * Runs slack-mcp-server for interactive agent sessions (.mcp.json, .pi/mcp.json) with one
 * workspace's tokens. Reads config and the channel cache from the primary checkout, since
 * worktrees have neither.
 */
import { join } from "node:path";
import { loadConfig } from "./config";
import { agentCacheDir, serverEnv } from "./sources/slack";

const primary = process.argv[2]!;
const cfg = loadConfig(primary);
const slack = Object.keys(cfg.sources.slack);
const name = process.argv[3] ?? slack[0];
if (!name || !slack.includes(name))
  throw new Error(`no slack source ${name ?? ""} in triage.local.yaml (have: ${slack.join(", ")})`);

const env = serverEnv(name, process.env, agentCacheDir(join(primary, ".state"), name));
// Read-only by default: message text is untrusted, and marking read would hide messages from
// triage. SLACK_<NAME>_ENABLED_TOOLS overrides; `all` enables every tool, including posting
// (SLACK_<NAME>_ADD_MESSAGE_TOOL may still limit channels).
const tools = process.env[`SLACK_${name.toUpperCase()}_ENABLED_TOOLS`];
if (tools === "all") {
  delete env.SLACK_MCP_ENABLED_TOOLS;
  for (const gate of ["ADD_MESSAGE", "REACTION", "ATTACHMENT"])
    env[`SLACK_MCP_${gate}_TOOL`] ??= "true";
} else
  env.SLACK_MCP_ENABLED_TOOLS =
    tools ??
    "channels_list,channels_me,conversations_history,conversations_replies,conversations_search_messages,conversations_unreads,saved_list,usergroups_list,usergroups_me,users_search";

const proc = Bun.spawn(["slack-mcp-server", "--transport", "stdio"], {
  env,
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await proc.exited);
