import type { EarthquakeSource } from "../config";
import { fetchJson } from "../http";
import type { CollectCtx, Signal } from "../signal";

type Quake = {
  id: string;
  properties: {
    mag: number;
    title: string;
    time: number;
    url: string;
    felt: number | null;
    alert: string | null;
  };
};

/**
 * USGS earthquakes since `ctx.since` within `km` of the point. Each quake is its own cursor
 * stream: USGS revises magnitudes, so one can cross `min_magnitude` after newer quakes.
 */
export async function collectEarthquake(
  name: string,
  source: EarthquakeSource,
  ctx: CollectCtx,
): Promise<Signal[]> {
  const query = new URLSearchParams({
    format: "geojson",
    eventtype: "earthquake",
    latitude: String(source.lat),
    longitude: String(source.lon),
    maxradiuskm: String(source.km),
    minmagnitude: String(source.min_magnitude),
    starttime: ctx.since,
  });
  const { features } = await fetchJson<{ features: Quake[] }>(
    `https://earthquake.usgs.gov/fdsnws/event/1/query?${query}`,
  );
  return features.map(({ id, properties: q }) => ({
    key: `${name}:${id}`,
    source: name,
    kind: "earthquake",
    channel: name,
    stream: id,
    ts: (q.time / 1000).toFixed(3),
    time: new Date(q.time).toISOString(),
    author: "USGS",
    text: [
      q.title,
      q.felt ? `felt by ${q.felt} reporters` : "",
      q.alert && q.alert !== "green" ? `PAGER ${q.alert} alert (damage or casualties likely)` : "",
    ]
      .filter(Boolean)
      .join(", "),
    url: q.url,
  }));
}
