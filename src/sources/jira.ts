import type { JiraSource } from "../config";
import { credentials, fetchJson } from "../http";
import type { CollectCtx, Signal } from "../signal";

/** emailAddress is present only when the user's profile visibility allows it. */
type User = { accountId: string; displayName: string; accountType: string; emailAddress?: string };

export type Issue = {
  key: string;
  fields: {
    summary: string;
    assignee: { accountId: string } | null;
    reporter: { accountId: string } | null;
    comment?: { comments: { id: string; author: User; body: string; created: string }[] };
  };
  changelog?: {
    histories: {
      id: string;
      author?: User;
      created: string;
      items: { field: string; to: string | null }[];
    }[];
  };
};

/** Jira Cloud basic auth from `JIRA_<NAME>_EMAIL` and `JIRA_<NAME>_API_TOKEN`. */
export function jiraAuth(name: string, env: Record<string, string | undefined>): string {
  const [email, token] = credentials(env, `JIRA_${name.toUpperCase()}_`, ["EMAIL", "API_TOKEN"]);
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

export const jiraGet = <T>(
  source: JiraSource,
  auth: string,
  path: string,
  init: RequestInit = {},
) =>
  fetchJson<T>(`${source.url.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      Authorization: auth,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });

/** Comments and assignments from people on issues I'm assigned, reported, or watch. */
export async function collectJira(
  name: string,
  source: JiraSource,
  ctx: CollectCtx,
): Promise<Signal[]> {
  const auth = jiraAuth(name, ctx.env);
  const me = await jiraGet<User>(source, auth, "/rest/api/2/myself");
  // Relative JQL dates avoid the profile time zone that absolute ones are read in.
  const minutes = Math.ceil((Date.now() - Date.parse(ctx.since)) / 60_000) + 1;
  const jql = `updated >= -${minutes}m AND (assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser())`;
  const issues: Issue[] = [];
  let nextPageToken: string | undefined;
  do {
    const page = await jiraGet<{ issues: Issue[]; nextPageToken?: string }>(
      source,
      auth,
      "/rest/api/2/search/jql",
      {
        method: "POST",
        body: JSON.stringify({
          jql,
          fields: ["summary", "assignee", "reporter", "comment"],
          expand: "changelog",
          maxResults: 50,
          nextPageToken,
        }),
      },
    );
    issues.push(...page.issues);
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);
  return issuesToSignals(name, source.url, me.accountId, issues, ctx.since);
}

/**
 * Keeps comments that mention me or land on my issues, and assignments to me, made by people
 * since `since`. App users (Automation, GitHub for Jira) and my own activity are dropped.
 */
export function issuesToSignals(
  name: string,
  url: string,
  me: string,
  issues: Issue[],
  since: string,
): Signal[] {
  const from = Date.parse(since);
  const base = url.replace(/\/$/, "");
  const byPerson = (u: User | undefined, at: string): u is User =>
    !!u && u.accountType === "atlassian" && u.accountId !== me && Date.parse(at) >= from;
  const signal = (
    issue: Issue,
    id: string,
    author: User,
    at: string,
    text: string,
    link: string,
  ): Signal => ({
    key: `${name}:${issue.key}:${id}`,
    source: name,
    kind: "jira",
    channel: issue.key,
    ts: (Date.parse(at) / 1000).toFixed(3),
    time: new Date(Date.parse(at)).toISOString(),
    author: author.displayName,
    ...(author.emailAddress ? { email: author.emailAddress } : {}),
    text,
    url: link,
  });
  return issues.flatMap((issue) => {
    const { summary, assignee, reporter } = issue.fields;
    const mine = assignee?.accountId === me || reporter?.accountId === me;
    const browse = `${base}/browse/${issue.key}`;
    const comments = (issue.fields.comment?.comments ?? [])
      .filter((c) => byPerson(c.author, c.created))
      .filter((c) => mine || c.body.includes(`[~accountid:${me}]`))
      .map((c) => {
        const body = c.body
          .replaceAll(`[~accountid:${me}]`, "@me")
          .replace(/\[~accountid:[^\]]+\]/g, "@someone");
        return signal(
          issue,
          `c${c.id}`,
          c.author,
          c.created,
          `comment: ${summary} — ${body}`,
          `${browse}?focusedCommentId=${c.id}`,
        );
      });
    const assigned = (issue.changelog?.histories ?? [])
      .filter(
        (h) =>
          byPerson(h.author, h.created) &&
          h.items.some((i) => i.field === "assignee" && i.to === me),
      )
      .map((h) =>
        signal(issue, `a${h.id}`, h.author!, h.created, `assigned to me: ${summary}`, browse),
      );
    return [...comments, ...assigned];
  });
}
