import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
  // Enterprise Grid can revoke a desktop session used with a different HTTP/TLS fingerprint.
  if (browser && (!out.SLACK_MCP_USER_AGENT || out.SLACK_MCP_CUSTOM_TLS !== "true")) {
    throw new Error(
      `${prefix}USER_AGENT and ${prefix}CUSTOM_TLS=true are required; re-run \`task setup:slack -- ${name}\` before using the xoxc/xoxd tokens`,
    );
  }
  return {
    ...out,
    // usergroups_me can also join and leave groups, but only this code calls it, with action list.
    SLACK_MCP_ENABLED_TOOLS:
      "conversations_unreads,conversations_replies,conversations_history,conversations_search_messages,usergroups_me",
    SLACK_MCP_USERS_CACHE: join(cacheDir, "users_cache.json"),
    SLACK_MCP_CHANNELS_CACHE: join(cacheDir, "channels_cache_v2.json"),
    SLACK_MCP_LOG_LEVEL: out.SLACK_MCP_LOG_LEVEL ?? "warn",
  };
}

export type WebApi = (method: string, args?: Record<string, string>) => Promise<any>;

/**
 * Slack's internal web API with this workspace's desktop session, for what slack-mcp-server
 * lacks. It skips the server's custom TLS, which Enterprise Grid may notice.
 */
export function webApi(name: string, env: Record<string, string | undefined>): WebApi {
  const out = serverEnv(name, env, "");
  const token = out.SLACK_MCP_XOXC_TOKEN;
  if (!token) throw new Error(`needs SLACK_${name.toUpperCase()}_XOXC_TOKEN/XOXD_TOKEN`);
  return async (method, args = {}) => {
    const form = new FormData();
    form.set("token", token);
    for (const [k, v] of Object.entries(args)) form.set(k, v);
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      body: form,
      headers: { cookie: `d=${out.SLACK_MCP_XOXD_TOKEN}`, "user-agent": out.SLACK_MCP_USER_AGENT! },
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as any;
    if (!json.ok) throw new Error(`slack/${name} ${method}: ${json.error ?? "failed"}`);
    return json;
  };
}

type Call = (tool: string, args: Record<string, unknown>) => Promise<Record<string, string>[]>;

/** A workspace's running server, reused for collection and context so one triage run opens
 * one Slack session per source instead of re-authenticating for the context pass. */
export type SlackServer = Workspace & { call: Call; close: () => Promise<void> };

/** What turns this workspace's message rows into signals. */
type Workspace = { users: Users; channels: Channel[]; me: Me };

/** What tells which messages are meant for me. */
type Me = {
  /** Empty when search finds no message of mine to learn it from. */
  id: string;
  /** User groups I belong to. */
  groups: Set<string>;
  /** `channel:thread` of the threads I started or replied in lately. */
  threads: Set<string>;
  /** Channel → timestamps of my recent top-level messages there. */
  posts: Map<string, string[]>;
  /** My recent messages; a reply here resolves a follow-up. */
  mine: Mine[];
};

export type Mine = { channel: string; ts: string; thread?: string };

/** Stream of thread replies found by search, which carry no unread state. */
export const THREAD_STREAM = "thread-mentions";

/** Starts a workspace's slack-mcp-server with `env`. Caller must `close()` the client. */
export async function connectServer(name: string, env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "slack-mcp-server",
    args: ["--transport", "stdio"],
    env,
    stderr: "inherit",
  });
  const client = new Client({ name: "watch", version: "1" });
  try {
    await client.connect(transport, { timeout: TIMEOUT_MS });
  } catch (e) {
    // The server exits at startup on invalid_auth, so connect just sees the pipe close.
    await client.close();
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `${msg} — if the log shows invalid_auth, the stealth tokens expired; re-run: task setup:slack ${name}`,
    );
  }
  return client;
}

/** Calls a tool and returns its text, throwing on a tool error. */
export async function callText(
  client: Client,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await client.callTool({ name: tool, arguments: args }, undefined, {
    timeout: TIMEOUT_MS,
  });
  const text = (result.content as { type: string; text?: string }[])
    .flatMap((c) => (c.type === "text" && c.text ? [c.text] : []))
    .join("");
  if (result.isError) throw new Error(`${tool}: ${text}`);
  return text;
}

/**
 * The cache for servers that agents use, apart from the one triage reads so they never write
 * it mid-run; seeded from it to skip the slow first sync.
 */
export function agentCacheDir(stateDir: string, name: string): string {
  const triageCache = join(stateDir, "slack", name);
  const cacheDir = join(triageCache, "mcp");
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  for (const f of ["users_cache.json", "channels_cache_v2.json"])
    if (!existsSync(join(cacheDir, f)) && existsSync(join(triageCache, f)))
      copyFileSync(join(triageCache, f), join(cacheDir, f));
  return cacheDir;
}

/** Starts this workspace's server, which only exposes read tools. Caller must `close()` it. */
export async function openServer(name: string, ctx: CollectCtx): Promise<SlackServer> {
  const cacheDir = join(ctx.stateDir, "slack", name);
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const client = await connectServer(name, serverEnv(name, ctx.env, cacheDir));
  const call: Call = async (tool, args) => parseCsv(await callText(client, tool, args));
  try {
    const channels = readChannels(cacheDir);
    const me = await whoAmI(call, ctx.since, channels);
    return { call, users: readUsers(cacheDir), channels, me, close: () => client.close() };
  } catch (e) {
    await client.close();
    throw e;
  }
}

// Search indexes with a delay. Taking only settled results keeps the mentions cursor from
// skipping a reply that is indexed after a newer one.
const SEARCH_LAG_S = 120;

/** Slack's after: excludes the given day, so start a day early; unseen() applies max_age. */
const searchAfter = (since: string) =>
  new Date(Date.parse(since) - 864e5).toISOString().slice(0, 10);

/** My id, groups, and recent messages. Search finds me by my own messages. */
async function whoAmI(call: Call, since: string, channels: Channel[]): Promise<Me> {
  const recent = await call("conversations_search_messages", {
    search_query: "from:me",
    filter_date_after: searchAfter(since),
    limit: 100,
  });
  const [any] = recent.length
    ? recent
    : await call("conversations_search_messages", { search_query: "from:me", limit: 1 });
  const id = any?.UserID ?? "";
  const groups = await call("usergroups_me", { action: "list" }).catch((e: unknown) => {
    console.warn(`usergroups_me: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  });
  const channel = channelNamer(channels);
  const threads = new Set<string>();
  const posts = new Map<string, string[]>();
  const mine: Mine[] = [];
  for (const r of recent) {
    if (!r.MsgID) continue;
    const name = channel(r.Channel ?? "");
    const thread = r.ThreadTs && r.ThreadTs !== r.MsgID ? r.ThreadTs : undefined;
    mine.push({ channel: name, ts: r.MsgID, ...(thread ? { thread } : {}) });
    // Search rows carry a thread only for replies; any top-level message may start one.
    threads.add(`${name}:${r.ThreadTs || r.MsgID}`);
    if (!r.ThreadTs || r.ThreadTs === r.MsgID)
      posts.set(name, [...(posts.get(name) ?? []), r.MsgID]);
  }
  return { id, groups: new Set(groups.flatMap((g) => g.id || [])), threads, posts, mine };
}

/**
 * Maps the channel ids that search and history rows carry ("C123 (#name)" or "C123") to the
 * unread scan's channel names, so keys, cursors, and my threads line up.
 */
function channelNamer(channels: Channel[]): (raw: string) => string {
  const names = new Map(channels.map((c) => [c.id, c.name]));
  return (raw) => {
    const id = /^(\S+) \(/.exec(raw)?.[1] ?? raw;
    return names.get(id) ?? id;
  };
}

export async function collectSlack(
  name: string,
  source: SlackSource,
  ctx: CollectCtx,
  server: SlackServer,
): Promise<Signal[]> {
  const { call, users, channels } = server;
  // VIPs are never excluded.
  const excluded: Excluded = (r) =>
    source.exclude_channels.includes(r.Channel!) &&
    !ctx.vips.has(users.get(r.UserID ?? "")?.email ?? "");
  const unreads = toSignals(
    name,
    server,
    await call("conversations_unreads", {
      include_messages: true,
      channel_types: source.channel_types,
      mentions_only: source.mentions_only,
      max_channels: source.max_channels,
      max_messages_per_channel: source.max_messages_per_channel,
    }),
    excluded,
    source.url ? linker(source.url, channels) : undefined,
  );
  if (!source.thread_mentions) return unreads;
  const seen = new Set(unreads.map((s) => s.key));
  const replies = await threadReplies(name, server, ctx, excluded);
  return [...unreads, ...replies.filter((s) => !seen.has(s.key))];
}

/**
 * Thread replies that mention me or land in threads I'm in. Unreads only cover top-level
 * messages, so these come from search, on their own cursor stream because search lags behind
 * the unread scan. The stream keeps its original name so handled replies stay handled.
 */
async function threadReplies(
  name: string,
  server: SlackServer,
  ctx: CollectCtx,
  excluded: Excluded,
): Promise<Signal[]> {
  const { id } = server.me;
  if (!id) return [];
  const search = (args: Record<string, unknown>) =>
    server.call("conversations_search_messages", {
      ...args,
      filter_threads_only: true,
      filter_date_after: searchAfter(ctx.since),
      limit: 100,
    });
  const mentions = await search({ search_query: `<@${id}>` });
  // with: matches threads I'm in, however long ago I joined them.
  const mine = await search({ filter_users_with: id });
  const channel = channelNamer(server.channels);
  const settled = Date.now() / 1000 - SEARCH_LAG_S;
  const replies = (rows: Row[]) =>
    rows.flatMap((r) =>
      !r.ThreadTs || r.ThreadTs === r.MsgID || r.UserID === id || Number(r.MsgID) > settled
        ? []
        : [{ ...r, Channel: channel(r.Channel ?? "") }],
    );
  const mentioned = toSignals(name, server, replies(mentions), excluded);
  const seen = new Set(mentioned.map((s) => s.key));
  const inMine = toSignals(name, server, replies(mine), excluded).flatMap((s) =>
    seen.has(s.key) ? [] : [{ ...s, to: s.to === "dm" || s.to === "me" ? s.to : "my_thread" }],
  );
  return [...mentioned, ...inMine].map((s) => ({ ...s, stream: THREAD_STREAM }));
}

/** Each signal's thread plus the channel's recent messages, so triage can understand it. */
export async function slackContext(
  name: string,
  server: SlackServer,
  signals: Signal[],
): Promise<Signal[][]> {
  const channel = channelNamer(server.channels);
  const out: Signal[][] = [];
  for (const s of signals) {
    const thread = await server.call("conversations_replies", {
      channel_id: s.channel,
      thread_ts: s.thread ?? s.ts,
      limit: "30",
    });
    const recent = await server.call("conversations_history", {
      channel_id: s.channel,
      limit: "15",
    });
    // History rows carry the resolved channel id.
    const rows = [...recent, ...thread].map((r) => ({ ...r, Channel: channel(r.Channel ?? "") }));
    out.push(toSignals(name, server, rows));
  }
  return out;
}

type Channel = { id: string; name: string; im?: boolean; mpim?: boolean };

/** The server's channel cache, written on its first sync. */
export function readChannels(cacheDir: string): Channel[] {
  const path = join(cacheDir, "channels_cache_v2.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Channel[]) : [];
}

/** User id → profile display name (or real name) and email, from the server's users cache.
 * Message rows only carry the handle and real name, and handles are often opaque. */
type Users = Map<string, { name?: string; email?: string; bot?: boolean }>;

export function readUsers(cacheDir: string): Users {
  const path = join(cacheDir, "users_cache.json");
  if (!existsSync(path)) return new Map();
  const users = JSON.parse(readFileSync(path, "utf8")) as {
    id: string;
    is_bot?: boolean;
    profile?: { display_name?: string; real_name?: string; email?: string };
  }[];
  return new Map(
    users.map((u) => [
      u.id,
      {
        name: u.profile?.display_name || u.profile?.real_name || undefined,
        email: u.profile?.email?.toLowerCase(),
        bot: u.is_bot || u.id === "USLACKBOT",
      },
    ]),
  );
}

type Row = Record<string, string>;
type Excluded = (row: Row) => boolean;

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
  ws: Workspace,
  rows: Row[],
  excluded: Excluded = () => false,
  link?: Link,
): Signal[] {
  const kinds = new Map(ws.channels.map((c) => [c.name, c.im ? "dm" : c.mpim ? "group_dm" : ""]));
  return rows
    .filter((r) => r.MsgID && r.Channel && !excluded(r))
    .map((r) => {
      const user = ws.users.get(r.UserID ?? "");
      const thread = r.ThreadTs && r.ThreadTs !== r.MsgID ? r.ThreadTs : undefined;
      const url = r.Permalink || link?.(r.Channel!, r.MsgID!, thread); // search rows carry one
      // The server reports an uncached channel by its id.
      const kind = kinds.get(r.Channel!) ?? (/^D[A-Z0-9]+$/.test(r.Channel!) ? "dm" : "");
      const to = addressedTo(ws.me, r.Channel!, kind, r.MsgID!, thread, r.Text ?? "");
      return {
        key: `${name}:${r.Channel}:${r.MsgID}`,
        source: name,
        kind: "slack",
        channel: r.Channel!,
        ts: r.MsgID!,
        time: r.Time ?? "",
        author: user?.name || r.RealName || r.UserName || r.BotName || r.UserID || "unknown",
        ...(user?.email ? { email: user.email } : {}),
        text: readable(r.Text ?? "", ws),
        ...(thread ? { thread } : {}),
        ...(url ? { url } : {}),
        ...(to ? { to } : {}),
        ...(r.BotName || user?.bot ? { bot: true as const } : {}),
      };
    });
}

// A message soon after my own in the same channel likely answers me.
const AFTER_ME_S = 30 * 60;

/**
 * Who a message is for, from my point of view, most specific first. Reads Slack's mention
 * markup, which typed text cannot produce (Slack escapes a typed `<` as `&lt;`).
 */
function addressedTo(
  me: Me,
  channel: string,
  kind: string,
  ts: string,
  thread: string | undefined,
  text: string,
): string | undefined {
  if (kind === "dm") return "dm";
  const people = [...text.matchAll(/<@([UW][A-Z0-9]+)/g)].map((m) => m[1]);
  if (people.includes(me.id)) return "me";
  if (thread && me.threads.has(`${channel}:${thread}`)) return "my_thread";
  const groups = [...text.matchAll(/<!subteam\^([A-Z0-9]+)/g)].map((m) => m[1]!);
  if (groups.some((g) => me.groups.has(g))) return "my_team";
  if (/<!(here|channel|everyone)[|>]/.test(text)) return "everyone";
  if (people.length || groups.length) return "others";
  const after = (mine: string) => Number(ts) - Number(mine);
  if (!thread && me.posts.get(channel)?.some((m) => after(m) > 0 && after(m) <= AFTER_ME_S))
    return "after_me";
  if (kind === "group_dm") return "group_dm";
}

/** Slack mention and channel markup as the names a reader would see. */
function readable(text: string, { users, channels }: Workspace): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => {
      return `@${users.get(id)?.name || label || id}`;
    })
    .replace(
      /<!subteam\^[A-Z0-9]+(?:\|@?([^>]*))?>/g,
      (_, handle?: string) => `@${handle || "group"}`,
    )
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => {
      return label ? `#${label}` : (channels.find((c) => c.id === id)?.name ?? `#${id}`);
    });
}
