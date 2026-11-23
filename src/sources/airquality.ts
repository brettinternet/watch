import type { AirQualitySource } from "../config";
import { fetchJson } from "../http";
import type { Signal } from "../signal";

const UNHEALTHY = 151;
const level = (aqi: number) =>
  aqi > 300 ? "hazardous" : aqi > 200 ? "very unhealthy" : "unhealthy";

export type Forecast = {
  utc_offset_seconds: number;
  hourly: { time: string[]; us_aqi: (number | null)[] };
};

/** Hourly US AQI forecast for today and tomorrow at the point, from Open-Meteo. */
export async function collectAirQuality(name: string, source: AirQualitySource): Promise<Signal[]> {
  const query = new URLSearchParams({
    latitude: String(source.lat),
    longitude: String(source.lon),
    hourly: "us_aqi",
    forecast_days: "2",
    timezone: "auto",
  });
  const forecast = await fetchJson<Forecast>(
    `https://air-quality-api.open-meteo.com/v1/air-quality?${query}`,
  );
  return forecastToSignals(name, forecast, Date.now());
}

/**
 * One signal per local day whose remaining hours reach unhealthy, at its peak. The day is the
 * cursor stream and its midnight the ts, so each bad day notifies once however often it's
 * re-forecast.
 */
export function forecastToSignals(name: string, f: Forecast, now: number): Signal[] {
  // Hourly times are local wall clock without an offset.
  const epoch = (local: string) => Date.parse(`${local}Z`) - f.utc_offset_seconds * 1000;
  const peaks = new Map<string, { hour: string; aqi: number }>();
  f.hourly.time.forEach((hour, i) => {
    const aqi = f.hourly.us_aqi[i];
    if (aqi == null || aqi < UNHEALTHY || epoch(hour) < now - 3_600_000) return;
    const day = hour.slice(0, 10);
    if (aqi > (peaks.get(day)?.aqi ?? 0)) peaks.set(day, { hour, aqi });
  });
  return [...peaks].map(([day, peak]) => {
    const midnight = epoch(`${day}T00:00`);
    return {
      key: `${name}:${day}`,
      source: name,
      kind: "airquality",
      channel: name,
      stream: day,
      ts: String(midnight / 1000),
      time: new Date(midnight).toISOString(),
      author: "Open-Meteo",
      text: `Air quality forecast ${level(peak.aqi)} on ${day}: US AQI peaks at ${peak.aqi} around ${peak.hour.slice(11)}`,
    };
  });
}
