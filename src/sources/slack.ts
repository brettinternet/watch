import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
  // Without the app's User-Agent, Enterprise Grid revokes the session and signs the user out everywhere.
  if (browser && !out.SLACK_MCP_USER_AGENT) {
    throw new Error(
      `${prefix}USER_AGENT is not set; re-run \`task setup:slack -- ${name}\` before using the xoxc/xoxd tokens`,
    );
  }
  return {
    ...out,
    SLACK_MCP_ENABLED_TOOLS:
      "conversations_unreads,conversations_replies,conversations_history,conversations_search_messages",
    SLACK_MCP_USERS_CACHE: join(cacheDir, "users_cache.json"),
    SLACK_MCP_CHANNELS_CACHE: join(cacheDir, "channels_cache_v2.json"),
    SLACK_MCP_LOG_LEVEL: out.SLACK_MCP_LOG_LEVEL ?? "warn",
  };
}

type Call = (tool: string, args: Record<string, unknown>) => Promise<Record<string, string>[]>;

/** Runs `fn` against this workspace's server, which only exposes read tools. */
async function withServer<T>(
  name: string,
  ctx: CollectCtx,
  fn: (call: Call, cacheDir: string) => Promise<T>,
): Promise<T> {
  const cacheDir = join(ctx.stateDir, "slack", name);
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const transport = new StdioClientTransport({
    command: "slack-mcp-server",
    args: ["--transport", "stdio"],
    env: serverEnv(name, ctx.env, cacheDir),
    stderr: "inherit",
  });
  const client = new Client({ name: "watch-triage", version: "1" });
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
    const call: Call = async (tool, args) => {
      const result = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: TIMEOUT_MS,
      });
      const text = (result.content as { type: string; text?: string }[])
        .flatMap((c) => (c.type === "text" && c.text ? [c.text] : []))
        .join("");
      if (result.isError) throw new Error(`${tool}: ${text}`);
      return parseCsv(text);
    };
    return await fn(call, cacheDir);
  } finally {
    await client.close();
  }
}

// Search indexes with a delay. Taking only settled results keeps the mentions cursor from
// skipping a reply that is indexed after a newer one.
const SEARCH_LAG_S = 120;

export function collectSlack(
  name: string,
  source: SlackSource,
  ctx: CollectCtx,
): Promise<Signal[]> {
  return withServer(name, ctx, async (call, cacheDir) => {
    const channels = readChannels(cacheDir);
    const unreads = toSignals(
      name,
      await call("conversations_unreads", {
        include_messages: true,
        channel_types: source.channel_types,
        mentions_only: source.mentions_only,
        max_channels: source.max_channels,
        max_messages_per_channel: source.max_messages_per_channel,
      }),
      source.exclude_channels,
      source.url ? linker(source.url, channels) : undefined,
    );
    if (!source.thread_mentions) return unreads;
    const seen = new Set(unreads.map((s) => s.key));
    const mentions = await threadMentions(name, call, ctx, channels, source.exclude_channels);
    return [...unreads, ...mentions.filter((s) => !seen.has(s.key))];
  });
}

/**
 * Thread replies that mention me. Unreads only cover top-level messages, so these come from
 * search, on their own cursor stream because search lags behind the unread scan.
 */
async function threadMentions(
  name: string,
  call: Call,
  ctx: CollectCtx,
  channels: Channel[],
  exclude: string[],
): Promise<Signal[]> {
  const [mine] = await call("conversations_search_messages", { search_query: "from:me", limit: 1 });
  if (!mine?.UserID) return []; // search finds me by my own messages
  // Slack's after: excludes the given day, so start a day early; unseen() applies max_age.
  const after = new Date(Date.parse(ctx.since) - 864e5).toISOString().slice(0, 10);
  const rows = await call("conversations_search_messages", {
    search_query: `<@${mine.UserID}>`,
    filter_threads_only: true,
    filter_date_after: after,
    limit: 100,
  });
  const names = new Map(channels.map((c) => [c.id, c.name]));
  const settled = Date.now() / 1000 - SEARCH_LAG_S;
  const replies = rows.flatMap((r) => {
    if (!r.ThreadTs || r.ThreadTs === r.MsgID || Number(r.MsgID) > settled) return [];
    const id = /^(\S+) \(/.exec(r.Channel ?? "")?.[1] ?? r.Channel ?? ""; // "C123 (#name)"
    return [{ ...r, Channel: names.get(id) ?? id }]; // match the unread scan's channel names
  });
  return toSignals(name, replies, exclude).map((s) => ({ ...s, stream: "thread-mentions" }));
}

/** Each signal's thread plus the channel's recent messages, so triage can understand it. */
export function slackContext(
  name: string,
  ctx: CollectCtx,
  signals: Signal[],
): Promise<Signal[][]> {
  return withServer(name, ctx, async (call) => {
    const out: Signal[][] = [];
    for (const s of signals) {
      const thread = await call("conversations_replies", {
        channel_id: s.channel,
        thread_ts: s.thread ?? s.ts,
        limit: "30",
      });
      const recent = await call("conversations_history", { channel_id: s.channel, limit: "15" });
      out.push(toSignals(name, [...recent, ...thread], []));
    }
    return out;
  });
}

type Channel = { id: string; name: string };

/** The server's channel cache, written on its first sync. */
function readChannels(cacheDir: string): Channel[] {
  const path = join(cacheDir, "channels_cache_v2.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Channel[]) : [];
}

type Link = (channel: string, ts: string, thread?: string) => string | undefined;

/**
 * Unread rows carry channel names, not ids, so map names to ids through the server's channel
 * cache. Thread replies need thread_ts and cid to open in their thread.
 */
function linker(base: string, channels: Channel[]): Link {
  const ids = new Map(channels.map((c) => [c.name, c.id]));
  return (channel, ts, thread) => {
    // The server reports an uncached channel by its id.
    const id = ids.get(channel) ?? (/^[CDG][A-Z0-9]{6,}$/.test(channel) ? channel : undefined);
    if (!id) return undefined;
    const url = new URL(`archives/${id}/p${ts.replace(".", "")}`, base.replace(/\/*$/, "/"));
    if (thread) {
      url.searchParams.set("thread_ts", thread);
      url.searchParams.set("cid", id);
    }
    return url.href;
  };
}

export function toSignals(
  name: string,
  rows: Record<string, string>[],
  exclude: string[],
  link?: Link,
): Signal[] {
  return rows
    .filter((r) => r.MsgID && r.Channel && !exclude.includes(r.Channel))
    .map((r) => {
      const thread = r.ThreadTs && r.ThreadTs !== r.MsgID ? r.ThreadTs : undefined;
      const url = r.Permalink || link?.(r.Channel!, r.MsgID!, thread); // search rows carry one
      return {
        key: `${name}:${r.Channel}:${r.MsgID}`,
        source: name,
        kind: "slack",
        channel: r.Channel!,
        ts: r.MsgID!,
        time: r.Time ?? "",
        author: r.RealName || r.UserName || r.BotName || r.UserID || "unknown",
        text: r.Text ?? "",
        ...(thread ? { thread } : {}),
        ...(url ? { url } : {}),
      };
    });
}
