import type { GithubSource } from "../config";
import type { CollectCtx, Signal } from "../signal";

type Pr = {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  author: { login?: string } | null;
};

/** Recently merged PRs matching `author` across the configured repos, via `gh`. */
export async function collectGithub(
  name: string,
  source: GithubSource,
  ctx: CollectCtx,
): Promise<Signal[]> {
  const since = ctx.since.slice(0, 10); // gh search takes a date: merged:>=YYYY-MM-DD
  const search = `author:${source.author} merged:>=${since}`;
  const signals: Signal[] = [];
  for (const repo of source.repos) {
    const proc = Bun.spawn(
      ["gh", "pr", "list", "--repo", repo, "--state", "merged", "--search", search, "--limit", "50", "--json", "number,title,url,mergedAt,author"],
      { env: ctx.env, stdout: "pipe", stderr: "pipe" },
    ); // prettier-ignore
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`gh pr list ${repo}: ${err.trim().slice(-300)}`);
    signals.push(...prsToSignals(name, repo, JSON.parse(out) as Pr[]));
  }
  return signals;
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
      text: `${p.title} — ${p.url}`,
    }));
}
