import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { SlackSource } from "../config";
import { parseCsv } from "../csv";
import type { CollectCtx, Signal } from "../signal";

const TIMEOUT_MS = 5 * 60_000; // first sync of a large workspace's user/channel cache is slow

/**
 * `SLACK_<NAME>_*` variables become this workspace's `SLACK_MCP_*` server settings
 * (e.g. SLACK_ACME_XOXC_TOKEN → SLACK_MCP_XOXC_TOKEN). Nothing else is inherited, so one
 * workspace's server never sees another's tokens.
 */
export function serverEnv(
  name: string,
  env: Record<string, string | undefined>,
  cacheDir: string,
): Record<string, string> {
  const prefix = `SLACK_${name.toUpperCase()}_`;
  const out: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR"]) if (env[key]) out[key] = env[key];
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(prefix) && value) out[`SLACK_MCP_${key.slice(prefix.length)}`] = value;
  }
  const browser = out.SLACK_MCP_XOXC_TOKEN && out.SLACK_MCP_XOXD_TOKEN;
  if (!browser && !out.SLACK_MCP_XOXP_TOKEN) {
    throw new Error(
      `set ${prefix}XOXC_TOKEN and ${prefix}XOXD_TOKEN (or ${prefix}XOXP_TOKEN) in .env.local`,
    );
  }
  return {
    ...out,
    SLACK_MCP_ENABLED_TOOLS: "conversations_unreads",
    SLACK_MCP_USERS_CACHE: join(cacheDir, "users_cache.json"),
    SLACK_MCP_CHANNELS_CACHE: join(cacheDir, "channels_cache_v2.json"),
    SLACK_MCP_LOG_LEVEL: out.SLACK_MCP_LOG_LEVEL ?? "warn",
  };
}

export async function collectSlack(
  name: string,
  source: SlackSource,
  ctx: CollectCtx,
): Promise<Signal[]> {
  const cacheDir = join(ctx.stateDir, "slack", name);
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const transport = new StdioClientTransport({
    command: "slack-mcp-server",
    args: ["--transport", "stdio"],
    env: serverEnv(name, ctx.env, cacheDir),
    stderr: "inherit",
  });
  const client = new Client({ name: "work-triage", version: "1" });
  try {
    try {
      await client.connect(transport, { timeout: TIMEOUT_MS });
    } catch (e) {
      // The server exits at startup on invalid_auth, so connect just sees the pipe close.
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `${msg} — if the log shows invalid_auth, the stealth tokens expired; re-run: task setup:slack ${name}`,
      );
    }
    const result = await client.callTool(
      {
        name: "conversations_unreads",
        arguments: {
          include_messages: true,
          channel_types: source.channel_types,
          mentions_only: source.mentions_only,
          max_channels: source.max_channels,
          max_messages_per_channel: source.max_messages_per_channel,
        },
      },
      undefined,
      { timeout: TIMEOUT_MS },
    );
    const text = (result.content as { type: string; text?: string }[])
      .flatMap((c) => (c.type === "text" && c.text ? [c.text] : []))
      .join("");
    if (result.isError) throw new Error(`conversations_unreads: ${text}`);
    return toSignals(name, parseCsv(text), source.exclude_channels);
  } finally {
    await client.close();
  }
}

export function toSignals(
  name: string,
  rows: Record<string, string>[],
  exclude: string[],
): Signal[] {
  return rows
    .filter((r) => r.MsgID && r.Channel && !exclude.includes(r.Channel))
    .map((r) => ({
      key: `${name}:${r.Channel}:${r.MsgID}`,
      source: name,
      kind: "slack",
      channel: r.Channel!,
      ts: r.MsgID!,
      time: r.Time ?? "",
      author: r.RealName || r.UserName || r.BotName || r.UserID || "unknown",
      text: r.Text ?? "",
      ...(r.ThreadTs && r.ThreadTs !== r.MsgID ? { thread: r.ThreadTs } : {}),
    }));
}
