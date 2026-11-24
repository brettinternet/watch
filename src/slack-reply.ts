/**
 * MCP server for an action's agent: replies in the threads of one triaged item's Slack messages,
 * reacts to them, and marks them read, and nothing else. The item's key comes from Noon's
 * $NOON_EVENT_FILE; where it may write comes from watch's own record, so an agent steered by
 * message text can't widen it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { type Replies, type ReplyTarget, replyTarget } from "./actions";
import { loadConfig } from "./config";
import { parseCsv } from "./csv";
import { readState } from "./signal";
import { agentCacheDir, callText, connectServer, serverEnv } from "./sources/slack";

const primary = process.argv[2]!;
const stateDir = join(primary, ".state");
const event = process.env.NOON_EVENT_FILE;
if (!event) throw new Error("NOON_EVENT_FILE is unset; run from a Noon job a triage action queued");
const { key } = JSON.parse(readFileSync(event, "utf8")) as { key?: string };
const targets = key ? readState<Replies>(join(stateDir, "replies.json"))[key]?.targets : undefined;
if (!targets) throw new Error(`no Slack messages recorded for triage item ${key ?? "(no key)"}`);

// One server per workspace, started on first use and limited to the item's channels; the
// thread and message are fixed here, which slack-mcp-server can't enforce.
const clients = new Map<string, Promise<Client>>();
function client(source: string): Promise<Client> {
  let c = clients.get(source);
  if (!c) {
    const channels = [
      ...new Set(targets!.filter((t) => t.source === source).map((t) => t.channel)),
    ];
    c = connectServer(source, {
      ...serverEnv(source, process.env, agentCacheDir(stateDir, source)),
      SLACK_MCP_ENABLED_TOOLS:
        "conversations_add_message,reactions_add,conversations_unreads,conversations_mark",
      SLACK_MCP_ADD_MESSAGE_TOOL: channels.join(","),
      SLACK_MCP_REACTION_TOOL: channels.join(","),
      SLACK_MCP_MARK_TOOL: "true", // a switch, not a channel list; run() fixes the channel
    });
    clients.set(source, c);
    c.catch(() => clients.delete(source)); // retry a failed start on the next call
  }
  return c;
}

type Act = (t: ReplyTarget, c: Client) => Promise<string>;

async function run(message: string | undefined, act: Act) {
  try {
    const target = replyTarget(targets!, message);
    const text = await act(target, await client(target.source));
    return { content: [{ type: "text" as const, text }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: String(e) }], isError: true };
  }
}

/**
 * Marks the channel read up to the message, only while the message is still unread: marking an
 * earlier ts moves the read marker back and makes newer messages unread again. Unreads are read
 * with triage's own filters, so a channel it could see but this can't is left alone.
 */
async function markRead(t: ReplyTarget, c: Client): Promise<string> {
  if (t.ts !== t.thread)
    throw new Error("thread replies can't be marked read; only channel messages can");
  const { channel_types, mentions_only, max_channels } =
    loadConfig(primary).sources.slack[t.source] ?? {};
  const text = await callText(c, "conversations_unreads", {
    include_messages: false,
    ...(channel_types ? { channel_types, mentions_only, max_channels } : {}),
  });
  // xoxp tokens prepend a note to the CSV.
  const row = parseCsv(text.slice(Math.max(0, text.indexOf("ChannelID")))).find(
    (r) => r.ChannelID === t.channel,
  );
  // Fixed-width "seconds.micros" timestamps compare as strings.
  if (!row || (row.LastRead ?? "") >= t.ts) return "Already read; left as is.";
  return callText(c, "conversations_mark", { channel_id: t.channel, ts: t.ts });
}

const message = z
  .string()
  .optional()
  .describe("Signal key from the triage item; optional when the item has one Slack thread");
const server = new McpServer({ name: "slack-reply", version: "1" });
server.registerTool(
  "reply",
  {
    description: "Post a reply as me in the Slack thread of a message from the triage item.",
    inputSchema: { text: z.string().min(1).describe("Message text (Markdown)"), message },
  },
  ({ text, message }) =>
    run(message, (t, c) =>
      callText(c, "conversations_add_message", {
        channel_id: t.channel,
        thread_ts: t.thread,
        text,
      }),
    ),
);
server.registerTool(
  "react",
  {
    description:
      "Add an emoji reaction as me to a message from the triage item, or its thread's root.",
    inputSchema: {
      emoji: z.string().min(1).describe("Emoji name, e.g. eyes"),
      message,
      thread: z.boolean().optional().describe("React to the message's thread root instead"),
    },
  },
  ({ emoji, message, thread }) =>
    run(message, (t, c) =>
      callText(c, "reactions_add", {
        channel_id: t.channel,
        timestamp: thread ? t.thread : t.ts,
        emoji,
      }),
    ),
);
server.registerTool(
  "mark_read",
  {
    description:
      "Mark a top-level message from the triage item read, with everything before it in its channel.",
    inputSchema: { message },
  },
  ({ message }) => run(message, markRead),
);
server.server.onclose = () => {
  for (const c of clients.values()) c.then((x) => x.close()).catch(() => {});
};
await server.connect(new StdioServerTransport());
