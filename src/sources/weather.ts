import type { WeatherSource } from "../config";
import { fetchJson } from "../http";
import type { Signal } from "../signal";

export type Alert = {
  id: string;
  sent: string;
  status: string;
  messageType: string;
  severity: string;
  certainty: string;
  urgency: string;
  event: string;
  headline: string | null;
  description: string;
  senderName: string;
};

const SEVERE = new Set(["Extreme", "Severe"]);
const LIKELY = new Set(["Observed", "Likely"]);
const SOON = new Set(["Immediate", "Expected"]);

/** Active National Weather Service alerts at the source's point. */
export async function collectWeather(name: string, source: WeatherSource): Promise<Signal[]> {
  const body = await fetchJson<{ features: { properties: Alert }[] }>(
    `https://api.weather.gov/alerts/active?point=${source.lat},${source.lon}`,
    { headers: { "User-Agent": "watch-triage", Accept: "application/geo+json" } },
  );
  const url = `https://forecast.weather.gov/MapClick.php?lat=${source.lat}&lon=${source.lon}`;
  return alertsToSignals(
    name,
    url,
    body.features.map((f) => f.properties),
  );
}

/** Keeps new, real warnings of severe weather that is happening or expected. Watches,
 * advisories, outlooks, and updates to an alert already sent are noise. */
export function alertsToSignals(name: string, url: string, alerts: Alert[]): Signal[] {
  return alerts
    .filter(
      (a) =>
        a.status === "Actual" &&
        a.messageType === "Alert" &&
        SEVERE.has(a.severity) &&
        LIKELY.has(a.certainty) &&
        SOON.has(a.urgency),
    )
    .map((a) => {
      const sent = Date.parse(a.sent);
      return {
        key: `${name}:${a.id}`,
        source: name,
        kind: "weather",
        channel: name,
        ts: (sent / 1000).toFixed(3),
        time: new Date(sent).toISOString(),
        author: a.senderName,
        text: `${a.severity} ${a.urgency.toLowerCase()} — ${a.headline ?? a.event}\n${a.description}`,
        url,
      };
    });
}
