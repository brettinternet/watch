import type { KevSource } from "../config";
import { fetchJson } from "../http";
import type { Signal } from "../signal";

export type Vuln = {
  cveID: string;
  vendorProject: string;
  product: string;
  vulnerabilityName: string;
  dateAdded: string;
  shortDescription: string;
  requiredAction: string;
  knownRansomwareCampaignUse: string;
};

/** CISA's catalog of vulnerabilities exploited in the wild, matched to software I use. */
export async function collectKev(name: string, source: KevSource): Promise<Signal[]> {
  const { vulnerabilities } = await fetchJson<{ vulnerabilities: Vuln[] }>(
    "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
  );
  return vulnsToSignals(name, source, vulnerabilities);
}

/**
 * Keeps entries whose vendor or product contains a `match`, case-insensitively. `dateAdded` is
 * only a date, so ts is its last second: an entry published late in the UTC day still lands
 * within `max_age` of the next run. Each CVE is its own cursor stream.
 */
export function vulnsToSignals(name: string, source: KevSource, vulns: Vuln[]): Signal[] {
  const wanted = source.match.map((m) => m.toLowerCase());
  return vulns
    .filter((v) => {
      const what = `${v.vendorProject} ${v.product}`.toLowerCase();
      return wanted.some((m) => what.includes(m));
    })
    .map((v) => {
      const added = Date.parse(`${v.dateAdded}T23:59:59Z`);
      return {
        key: `${name}:${v.cveID}`,
        source: name,
        kind: "kev",
        channel: `${v.vendorProject} ${v.product}`,
        stream: v.cveID,
        ts: String(added / 1000),
        time: new Date(added).toISOString(),
        author: "CISA",
        text: `${v.cveID} ${v.vulnerabilityName}: ${v.shortDescription}${v.knownRansomwareCampaignUse === "Known" ? " Used in ransomware." : ""}`,
        url: `https://nvd.nist.gov/vuln/detail/${v.cveID}`,
      };
    });
}
