import type { GithubSource } from "../config";
import type { CollectCtx, Signal } from "../signal";

type Pr = {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  author: { login?: string } | null;
};

export type OpenPr = {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  author: { login?: string } | null;
  mergeStateStatus: string;
  latestReviews: { state: string; submittedAt: string }[];
  statusCheckRollup: { completedAt?: string; startedAt?: string }[];
};

export type ReviewPr = {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  isDraft: boolean;
  author: { login?: string } | null;
  timelineItems: {
    nodes: { createdAt: string; requestedReviewer: { login?: string } | null }[];
  };
};

const REVIEWS = `query ($q: String!) {
  viewer { login }
  search(query: $q, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        number title url createdAt isDraft
        author { login }
        timelineItems(last: 100, itemTypes: [REVIEW_REQUESTED_EVENT]) {
          nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } } }
        }
      }
    }
  }
}`;

/**
 * Merged and/or ready-to-merge PRs matching `author`, and open PRs requesting my review, across
 * the configured repos, via `gh`.
 */
export async function collectGithub(
  name: string,
  source: GithubSource,
  ctx: CollectCtx,
): Promise<Signal[]> {
  const since = ctx.since.slice(0, 10); // gh search takes a date: merged:>=YYYY-MM-DD
  const signals: Signal[] = [];
  for (const repo of source.repos) {
    if (source.events.includes("merged")) {
      const search = `author:${source.author} merged:>=${since}`;
      const out = await gh(
        ["pr", "list", "--repo", repo, "--state", "merged", "--search", search, "--limit", "50", "--json", "number,title,url,mergedAt,author"],
        ctx.env,
      ); // prettier-ignore
      signals.push(...prsToSignals(name, repo, JSON.parse(out) as Pr[]));
    }
    if (source.events.includes("ready")) {
      const out = await gh(
        ["pr", "list", "--repo", repo, "--state", "open", "--author", source.author, "--limit", "50", "--json", "number,title,url,createdAt,author,mergeStateStatus,latestReviews,statusCheckRollup"],
        ctx.env,
      ); // prettier-ignore
      signals.push(...readyPrsToSignals(name, repo, JSON.parse(out) as OpenPr[]));
    }
    if (source.events.includes("review")) {
      const q = `repo:${repo} is:pr is:open user-review-requested:@me`;
      const out = await gh(["api", "graphql", "-f", `query=${REVIEWS}`, "-f", `q=${q}`], ctx.env);
      const { viewer, search } = (
        JSON.parse(out) as { data: { viewer: { login: string }; search: { nodes: ReviewPr[] } } }
      ).data;
      signals.push(...reviewPrsToSignals(name, repo, viewer.login, search.nodes));
    }
  }
  return signals;
}

/** Runs `gh` and returns its stdout; a nonzero exit throws with the end of stderr. */
export async function gh(args: string[], env: CollectCtx["env"]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")}: ${err.trim().slice(-300)}`);
  return out;
}

export function prsToSignals(name: string, repo: string, prs: Pr[]): Signal[] {
  return prs
    .filter((p) => p.mergedAt)
    .map((p) => ({
      key: `${name}:${repo}:#${p.number}`,
      source: name,
      kind: "github",
      channel: repo,
      ts: (Date.parse(p.mergedAt) / 1000).toFixed(3),
      time: p.mergedAt,
      author: p.author?.login ?? "unknown",
      text: `Merged: ${p.title} — ${p.url}`,
      url: p.url,
    }));
}

/**
 * Open PRs GitHub reports mergeable with every required check and review passing. GitHub has no
 * "became ready" time, so `ts` is the latest approval or check result, which stays put while the
 * PR stays ready and moves when a new push or review readies it again. Each PR is its own cursor
 * stream, since one can become ready after a newer one.
 */
export function readyPrsToSignals(name: string, repo: string, prs: OpenPr[]): Signal[] {
  return prs
    .filter((p) => p.mergeStateStatus === "CLEAN" || p.mergeStateStatus === "HAS_HOOKS")
    .map((p) => {
      const times = [
        p.createdAt,
        ...p.latestReviews.filter((r) => r.state === "APPROVED").map((r) => r.submittedAt),
        ...p.statusCheckRollup.map((c) => c.completedAt || c.startedAt || ""),
      ].map(Date.parse);
      const ms = Math.max(...times.filter((t) => !Number.isNaN(t)));
      return {
        key: `${name}:${repo}:#${p.number}:ready:${ms}`,
        source: name,
        kind: "github",
        channel: repo,
        stream: `${repo}#${p.number}:ready`,
        ts: (ms / 1000).toFixed(3),
        time: new Date(ms).toISOString(),
        author: p.author?.login ?? "unknown",
        text: `Ready to merge: ${p.title} — ${p.url}`,
        url: p.url,
      };
    });
}

/**
 * Open PRs that request my review directly; team requests are left out. `ts` is the latest
 * request of me, so a PR opened long ago, or re-requested after my review, still arrives as new.
 * Each PR is its own cursor stream, which follow-ups also use to see when the request is gone.
 */
export function reviewPrsToSignals(
  name: string,
  repo: string,
  me: string,
  prs: ReviewPr[],
): Signal[] {
  return prs
    .filter((p) => !p.isDraft)
    .map((p) => {
      const requests = p.timelineItems.nodes.filter((e) => e.requestedReviewer?.login === me);
      // A request older than the last 100 timeline events falls back to the PR's creation.
      const ms = Date.parse(requests.at(-1)?.createdAt ?? p.createdAt);
      return {
        key: `${name}:${repo}:#${p.number}:review:${ms}`,
        source: name,
        kind: "github",
        channel: repo,
        stream: `${repo}#${p.number}:review`,
        ts: (ms / 1000).toFixed(3),
        time: new Date(ms).toISOString(),
        author: p.author?.login ?? "unknown",
        text: `Review requested: ${p.title} — ${p.url}`,
        url: p.url,
      };
    });
}

/** What follow-ups need to see a PR handled: merged or closed, or reviewed by me, and when. */
export type PrOutcome = {
  state: "OPEN" | "MERGED" | "CLOSED";
  closedAt: string | null;
  viewerLatestReview: { submittedAt: string } | null;
};

const OUTCOME = `query ($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) { state closedAt viewerLatestReview { submittedAt } }
  }
}`;

export async function prOutcome(
  repo: string,
  n: number,
  env: CollectCtx["env"],
): Promise<PrOutcome> {
  const [owner, name] = repo.split("/");
  const out = await gh(
    ["api", "graphql", "-f", `query=${OUTCOME}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `n=${n}`],
    env,
  ); // prettier-ignore
  return (JSON.parse(out) as { data: { repository: { pullRequest: PrOutcome } } }).data.repository
    .pullRequest;
}

export type PrState = {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  author: { login?: string } | null;
  updatedAt: string;
  reviewDecision: string;
  reviewRequests: { login?: string; slug?: string }[];
  latestReviews: { author: { login?: string } | null; state: string }[];
  statusCheckRollup: { conclusion?: string; status?: string; state?: string }[];
};

/** A PR's current state as one line for triage context, looked up on the LLM's request. */
export async function prState(
  name: string,
  repo: string,
  n: number,
  env: CollectCtx["env"],
): Promise<Signal> {
  const fields =
    "number,title,url,state,isDraft,author,updatedAt,reviewDecision,reviewRequests,latestReviews,statusCheckRollup";
  const out = await gh(["pr", "view", String(n), "--repo", repo, "--json", fields], env);
  return prStateToSignal(name, repo, JSON.parse(out) as PrState);
}

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR"]);

export function prStateToSignal(name: string, repo: string, p: PrState): Signal {
  const by = (state: string) =>
    p.latestReviews.filter((r) => r.state === state).map((r) => `@${r.author?.login ?? "?"}`);
  const checks = p.statusCheckRollup;
  const status = [
    p.state.toLowerCase() + (p.isDraft ? " draft" : ""),
    ...(p.state === "OPEN" && p.reviewDecision
      ? [p.reviewDecision.toLowerCase().replace("_", " ")]
      : []),
    ...(p.reviewRequests.length
      ? [
          `review requested from ${p.reviewRequests.map((r) => (r.login ? `@${r.login}` : r.slug)).join(", ")}`,
        ]
      : []),
    ...(by("APPROVED").length ? [`approved by ${by("APPROVED").join(", ")}`] : []),
    ...(by("CHANGES_REQUESTED").length
      ? [`changes requested by ${by("CHANGES_REQUESTED").join(", ")}`]
      : []),
    ...(checks.length
      ? [
          checks.some((c) => FAILED.has(c.conclusion ?? c.state ?? ""))
            ? "checks failing"
            : checks.some((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING")
              ? "checks running"
              : "checks passing",
        ]
      : []),
  ];
  const ms = Date.parse(p.updatedAt);
  return {
    key: `${name}:${repo}:#${p.number}:state`,
    source: name,
    kind: "github",
    channel: repo,
    ts: (ms / 1000).toFixed(3),
    time: p.updatedAt,
    author: p.author?.login ?? "unknown",
    text: `PR #${p.number} "${p.title}": ${status.join(" · ")} — ${p.url}`,
    url: p.url,
  };
}
