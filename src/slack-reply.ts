/**
 * MCP server for an action's agent, limited to one triaged item: it can read, reply in, react to,
 * mark read, and save the item's Slack messages, and dismiss or snooze the item's follow-ups,
 * and nothing else. The item's key comes from Noon's $NOON_EVENT_FILE; what it may touch comes
 * from watch's own record, so an agent steered by message text can't widen it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { type Replies, type ReplyTarget, replyTarget } from "./actions";
import { Duration, loadConfig } from "./config";
import { parseCsv } from "./csv";
import { type Followups, ledgerPath, settle } from "./followups";
import { readState, writeState } from "./signal";
import { agentCacheDir, callText, connectServer, serverEnv, webApi } from "./sources/slack";

const primary = process.argv[2]!;
const stateDir = join(primary, ".state");
const event = process.env.NOON_EVENT_FILE;
if (!event) throw new Error("NOON_EVENT_FILE is unset; run from a Noon job a triage action queued");
const { key } = JSON.parse(readFileSync(event, "utf8")) as { key?: string };
const record = key ? readState<Replies>(join(stateDir, "replies.json"))[key] : undefined;
if (!record) throw new Error(`no record of triage item ${key ?? "(no key)"}; did its action run?`);
const { targets } = record;
const keys = new Set(record.keys);

// One server per workspace, started on first use and limited to the item's channels; the
// thread and message are fixed here, which slack-mcp-server can't enforce.
const clients = new Map<string, Promise<Client>>();
function client(source: string): Promise<Client> {
  let c = clients.get(source);
  if (!c) {
    const channels = [...new Set(targets.filter((t) => t.source === source).map((t) => t.channel))];
    c = connectServer(source, {
      ...serverEnv(source, process.env, agentCacheDir(stateDir, source)),
      SLACK_MCP_ENABLED_TOOLS:
        "conversations_add_message,reactions_add,conversations_replies,conversations_unreads,conversations_mark",
      SLACK_MCP_ADD_MESSAGE_TOOL: channels.join(","),
      SLACK_MCP_REACTION_TOOL: channels.join(","),
      SLACK_MCP_MARK_TOOL: "true", // a switch, not a channel list; mcp() fixes the channel
    });
    clients.set(source, c);
    c.catch(() => clients.delete(source)); // retry a failed start on the next call
  }
  return c;
}

/** Calls a slack-mcp-server tool in the target's channel. */
const mcp = async (t: ReplyTarget, tool: string, args: Record<string, unknown>) =>
  callText(await client(t.source), tool, { channel_id: t.channel, ...args });

async function run(act: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await act() }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: String(e) }], isError: true };
  }
}

const onMessage = (message: string | undefined, act: (t: ReplyTarget) => Promise<string>) =>
  run(() => act(replyTarget(targets, message)));

function duration(s: string): number {
  const d = Duration.safeParse(s);
  if (!d.success) throw new Error(d.error.issues[0]!.message);
  return d.data;
}

/**
 * Marks a channel message read, with everything before it in its channel, only while it's still
 * unread: marking an earlier ts moves the read marker back and makes newer messages unread
 * again. Unreads are read with triage's own filters, so a channel it could see but this can't is
 * left alone. A thread reply instead marks its whole thread read, up to the latest reply, which
 * can't move the marker back either.
 */
async function markRead(t: ReplyTarget): Promise<string> {
  if (t.ts !== t.thread) {
    const api = webApi(t.source, process.env);
    const { messages } = await api("conversations.replies", {
      channel: t.channel,
      ts: t.thread,
      limit: "1",
    });
    const latest: string = messages?.[0]?.latest_reply ?? t.ts;
    await api("subscriptions.thread.mark", {
      channel: t.channel,
      thread_ts: t.thread,
      ts: latest,
      read: "1",
    });
    return "Marked the thread read.";
  }
  const { channel_types, mentions_only, max_channels } =
    loadConfig(primary).sources.slack[t.source] ?? {};
  const text = await callText(await client(t.source), "conversations_unreads", {
    include_messages: false,
    ...(channel_types ? { channel_types, mentions_only, max_channels } : {}),
  });
  // xoxp tokens prepend a note to the CSV.
  const row = parseCsv(text.slice(Math.max(0, text.indexOf("ChannelID")))).find(
    (r) => r.ChannelID === t.channel,
  );
  // Fixed-width "seconds.micros" timestamps compare as strings.
  if (!row || (row.LastRead ?? "") >= t.ts) return "Already read; left as is.";
  return mcp(t, "conversations_mark", { ts: t.ts });
}

async function save(t: ReplyTarget, remindIn?: string): Promise<string> {
  const due = remindIn === undefined ? undefined : Date.now() + duration(remindIn);
  const api = webApi(t.source, process.env);
  const item = { item_id: t.channel, item_type: "message", ts: t.ts };
  await api("saved.add", item);
  if (due === undefined) return "Saved for later.";
  await api("saved.update", { ...item, date_due: String(Math.floor(due / 1000)) });
  return `Saved for later, due ${new Date(due).toISOString()}.`;
}

/** Dismisses, or snoozes until `until`, the open follow-ups on the item's signals. */
function settleFollowups(until?: number): string {
  const path = ledgerPath(primary);
  const ledger = readState<Followups>(path);
  const ids = Object.keys(ledger).filter(
    (id) => !ledger[id]!.closed && ledger[id]!.anchors.some((a) => keys.has(a.key)),
  );
  if (!ids.length) return "No open follow-up for this item.";
  for (const id of ids) ledger[id] = settle(ledger[id]!, Date.now(), until);
  writeState(path, ledger);
  const done = until === undefined ? "Dismissed" : `Snoozed until ${new Date(until).toISOString()}`;
  return `${done}: ${ids.map((id) => ledger[id]!.ask).join("; ")}`;
}

const message = z
  .string()
  .optional()
  .describe("Signal key from the triage item; optional when the item has one Slack thread");
const server = new McpServer({ name: "slack-reply", version: "1" });
server.registerTool(
  "read_thread",
  {
    description: "Read the Slack thread of a message from the triage item, up to 100 messages.",
    inputSchema: { message },
  },
  ({ message }) =>
    onMessage(message, (t) =>
      mcp(t, "conversations_replies", { thread_ts: t.thread, limit: "100" }),
    ),
);
server.registerTool(
  "reply",
  {
    description: "Post a reply as me in the Slack thread of a message from the triage item.",
    inputSchema: { text: z.string().min(1).describe("Message text (Markdown)"), message },
  },
  ({ text, message }) =>
    onMessage(message, (t) => mcp(t, "conversations_add_message", { thread_ts: t.thread, text })),
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
    onMessage(message, (t) =>
      mcp(t, "reactions_add", { timestamp: thread ? t.thread : t.ts, emoji }),
    ),
);
server.registerTool(
  "mark_read",
  {
    description:
      "Mark a message from the triage item read: a channel message with everything before it in its channel, a thread reply with its whole thread.",
    inputSchema: { message },
  },
  ({ message }) => onMessage(message, markRead),
);
server.registerTool(
  "save",
  {
    description:
      "Save a message from the triage item to my Slack saved items, optionally due later.",
    inputSchema: {
      message,
      remind_in: z.string().optional().describe("Due after this long, e.g. 2h or 1d"),
    },
  },
  ({ message, remind_in }) => onMessage(message, (t) => save(t, remind_in)),
);
server.registerTool(
  "dismiss",
  { description: "Close the triage item's follow-ups so they stop reminding me.", inputSchema: {} },
  () => run(async () => settleFollowups()),
);
server.registerTool(
  "snooze",
  {
    description: "Hold off the triage item's follow-up reminders for a while.",
    inputSchema: { for: z.string().describe("How long, e.g. 4h or 2d") },
  },
  ({ for: d }) => run(async () => settleFollowups(Date.now() + duration(d))),
);
server.server.onclose = () => {
  for (const c of clients.values()) c.then((x) => x.close()).catch(() => {});
};
await server.connect(new StdioServerTransport());
