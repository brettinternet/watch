import { credentials, fetchJson } from "../http";
import type { CollectCtx, Signal } from "../signal";

/** Inbox categories that are a direct ask. Status changes, subscriptions, reactions, PR
 * reviews, and the rest are dropped before triage. */
const CATEGORIES = new Set(["assignments", "mentions", "commentsAndReplies"]);

const COMMENT = "comment { body url externalUser { id } botActor { id } syncedWith { service } }";
const QUERY = `query ($since: DateTimeOrDuration!, $after: String) {
  notifications(first: 100, after: $after, filter: { createdAt: { gte: $since } }) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id type category createdAt readAt snoozedUntilAt
      actor { name email } botActor { id } externalUserActor { id }
      ... on IssueNotification { issue { identifier title url } ${COMMENT} }
      ... on ProjectNotification { project { name url } ${COMMENT} }
    }
  }
}`;

type Comment = {
  body: string;
  url: string;
  externalUser: object | null;
  botActor: object | null;
  syncedWith: object[] | null;
};

export type Notification = {
  id: string;
  type: string;
  category: string;
  createdAt: string;
  readAt: string | null;
  snoozedUntilAt: string | null;
  actor: { name: string; email?: string } | null;
  botActor: object | null;
  externalUserActor: object | null;
  issue?: { identifier: string; title: string; url: string };
  project?: { name: string; url: string };
  comment?: Comment | null;
};

type Page = {
  notifications: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Notification[];
  };
};

export const linearKey = (name: string, env: Record<string, string | undefined>) =>
  credentials(env, `LINEAR_${name.toUpperCase()}_`, ["API_KEY"])[0]!;

export async function linearQuery<T>(key: string, query: string, variables = {}): Promise<T> {
  const body = await fetchJson<{ data?: T; errors?: { message: string }[] }>(
    "https://api.linear.app/graphql",
    {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    },
  );
  if (body.errors?.length || !body.data)
    throw new Error(`linear: ${body.errors?.map((e) => e.message).join("; ") ?? "no data"}`);
  return body.data;
}

/** Unread Linear inbox notifications from people since `ctx.since`. */
export async function collectLinear(name: string, ctx: CollectCtx): Promise<Signal[]> {
  const key = linearKey(name, ctx.env);
  const nodes: Notification[] = [];
  let after: string | null = null;
  do {
    const page: Page = await linearQuery(key, QUERY, {
      since: ctx.since,
      after,
    });
    nodes.push(...page.notifications.nodes);
    after = page.notifications.pageInfo.hasNextPage ? page.notifications.pageInfo.endCursor : null;
  } while (after);
  return notificationsToSignals(name, nodes, Date.now());
}

/** Keeps unread, unsnoozed asks from a teammate. Anything an integration, bot, or synced
 * external user (GitHub, Slack) caused is a mirror of a source watched elsewhere. */
export function notificationsToSignals(name: string, nodes: Notification[], now: number): Signal[] {
  return nodes.flatMap((n) => {
    const target = n.issue
      ? { channel: n.issue.identifier, title: n.issue.title, url: n.issue.url }
      : n.project
        ? { channel: n.project.name, title: n.project.name, url: n.project.url }
        : undefined;
    const c = n.comment;
    const mirrored =
      !n.actor ||
      n.botActor ||
      n.externalUserActor ||
      (c && (c.externalUser || c.botActor || c.syncedWith?.length));
    const snoozed = n.snoozedUntilAt && Date.parse(n.snoozedUntilAt) > now;
    if (!target || mirrored || n.readAt || snoozed || !CATEGORIES.has(n.category)) return [];
    return [
      {
        key: `${name}:${n.id}`,
        source: name,
        kind: "linear",
        channel: target.channel,
        ts: (Date.parse(n.createdAt) / 1000).toFixed(3),
        time: n.createdAt,
        author: n.actor!.name,
        ...(n.actor!.email ? { email: n.actor!.email } : {}),
        text: `${n.type}: ${target.title}${c ? ` — ${c.body}` : ""}`,
        url: c?.url ?? target.url,
      },
    ];
  });
}
