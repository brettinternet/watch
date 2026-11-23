import type { TrafficSource } from "../config";
import { credentials, fetchJson } from "../http";
import type { CollectCtx, Signal } from "../signal";

/** One event from an IBI 511 developer API; times are Unix seconds. */
export type Event = {
  ID: number;
  Organization?: string;
  RoadwayName: string;
  DirectionOfTravel: string;
  Description: string;
  Reported: number | null;
  StartDate: number | null;
  Latitude: number;
  Longitude: number;
  LatitudeSecondary?: number | null;
  LongitudeSecondary?: number | null;
  EventType: string;
  IsFullClosure: boolean;
  Severity: string;
};

export async function trafficEvents(
  name: string,
  source: TrafficSource,
  env: Record<string, string | undefined>,
): Promise<Event[]> {
  const [key] = credentials(env, `TRAFFIC_${name.toUpperCase()}_`, ["API_KEY"]);
  const query = new URLSearchParams({ key: key!, format: "json" });
  return fetchJson<Event[]>(`${source.url.replace(/\/$/, "")}/api/v2/get/event?${query}`);
}

/** Active major incidents and closures within the source's areas. */
export async function collectTraffic(
  name: string,
  source: TrafficSource,
  ctx: CollectCtx,
): Promise<Signal[]> {
  return eventsToSignals(name, source, await trafficEvents(name, source, ctx.env), Date.now());
}

/** Great-circle distance in km. */
function km(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(a));
}

/**
 * Keeps started crashes, incidents, and closures that block every lane or are rated Major, with
 * either end inside an area. Roadwork and lesser events are noise. Each event is its own cursor
 * stream, so one escalated after newer events were handled still arrives, once.
 */
export function eventsToSignals(
  name: string,
  source: TrafficSource,
  events: Event[],
  now: number,
): Signal[] {
  const near = (e: Event) =>
    source.areas.some(
      (a) =>
        km(a.lat, a.lon, e.Latitude, e.Longitude) <= a.km ||
        (e.LatitudeSecondary != null &&
          e.LongitudeSecondary != null &&
          km(a.lat, a.lon, e.LatitudeSecondary, e.LongitudeSecondary) <= a.km),
    );
  return events
    .filter(
      (e) =>
        e.EventType !== "roadwork" &&
        (e.IsFullClosure || e.Severity === "Major") &&
        (e.StartDate ?? 0) * 1000 <= now &&
        near(e),
    )
    .map((e) => {
      const ts = Math.max(e.Reported ?? 0, e.StartDate ?? 0);
      return {
        key: `${name}:${e.ID}`,
        source: name,
        kind: "traffic",
        channel: e.RoadwayName,
        stream: String(e.ID),
        ts: String(ts),
        time: new Date(ts * 1000).toISOString(),
        author: e.Organization || name,
        text: `${e.IsFullClosure ? "Full closure" : `${e.Severity} ${e.EventType}`}, ${e.DirectionOfTravel}: ${e.Description}`,
        url: source.url,
      };
    });
}
