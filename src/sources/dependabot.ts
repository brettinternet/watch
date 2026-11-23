import type { DependabotSource } from "../config";
import type { CollectCtx, Signal } from "../signal";
import { gh } from "./github";

const QUERY = `query ($login: String!, $endCursor: String) {
  repositoryOwner(login: $login) {
    repositories(first: 50, after: $endCursor, isArchived: false, isFork: false, ownerAffiliations: OWNER) {
      pageInfo { hasNextPage endCursor }
      nodes {
        nameWithOwner
        vulnerabilityAlerts(states: [OPEN], last: 50) { # oldest first, so last is newest
          nodes {
            number createdAt
            securityVulnerability { severity package { name } advisory { summary } }
          }
        }
      }
    }
  }
}`;

export type Repo = {
  nameWithOwner: string;
  vulnerabilityAlerts: {
    nodes: {
      number: number;
      createdAt: string;
      securityVulnerability: {
        severity: string;
        package: { name: string };
        advisory: { summary: string };
      };
    }[];
  } | null;
};

type Page = { data: { repositoryOwner: { repositories: { nodes: Repo[] } } | null } };

/** Open Dependabot alerts across each owner's active, non-fork repos, via `gh`. */
export async function collectDependabot(
  name: string,
  source: DependabotSource,
  ctx: CollectCtx,
): Promise<Signal[]> {
  const repos: Repo[] = [];
  for (const login of source.owners) {
    const out = await gh(
      ["api", "graphql", "--paginate", "--slurp", "-f", `query=${QUERY}`, "-F", `login=${login}`],
      ctx.env,
    );
    const pages = JSON.parse(out) as Page[];
    if (!pages[0]?.data.repositoryOwner) throw new Error(`unknown GitHub owner ${login}`);
    repos.push(...pages.flatMap((p) => p.data.repositoryOwner!.repositories.nodes));
  }
  return alertsToSignals(name, repos);
}

/** Keeps critical and high alerts; moderate and low ones wait for a routine update. */
export function alertsToSignals(name: string, repos: Repo[]): Signal[] {
  return repos.flatMap((r) =>
    (r.vulnerabilityAlerts?.nodes ?? [])
      .filter((a) => ["CRITICAL", "HIGH"].includes(a.securityVulnerability.severity))
      .map((a) => ({
        key: `${name}:${r.nameWithOwner}#${a.number}`,
        source: name,
        kind: "dependabot",
        channel: r.nameWithOwner,
        stream: `${r.nameWithOwner}#${a.number}`,
        ts: (Date.parse(a.createdAt) / 1000).toFixed(3),
        time: new Date(Date.parse(a.createdAt)).toISOString(),
        author: "Dependabot",
        text: `${a.securityVulnerability.severity.toLowerCase()} ${a.securityVulnerability.package.name}: ${a.securityVulnerability.advisory.summary}`,
        url: `https://github.com/${r.nameWithOwner}/security/dependabot/${a.number}`,
      })),
  );
}
