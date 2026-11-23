import { expect, test } from "bun:test";
import { advance, unseen } from "../signal";
import { type Forecast, forecastToSignals } from "./airquality";

test("an unhealthy day notifies once at its remaining peak, however often it's re-forecast", () => {
  // UTC-7 location; local 10:00 on the 23rd is 17:00Z.
  const now = Date.parse("2026-11-23T17:00:00Z");
  const forecast = (aqi: number[]): Forecast => ({
    utc_offset_seconds: -7 * 3600,
    hourly: {
      time: ["2026-11-23T07:00", "2026-11-23T10:00", "2026-11-23T14:00", "2026-11-24T08:00"],
      us_aqi: aqi,
    },
  });

  // 07:00 is past, so its 250 is ignored; tomorrow is only moderate.
  const first = forecastToSignals("home", forecast([250, 160, 155, 90]), now);
  expect(first).toMatchObject([
    {
      stream: "2026-11-23",
      ts: String(Date.parse("2026-11-23T07:00:00Z") / 1000),
      text: "Air quality forecast unhealthy on 2026-11-23: US AQI peaks at 160 around 10:00",
    },
  ]);

  const later = forecastToSignals("home", forecast([250, 170, 210, 160]), now + 3_600_000);
  const fresh = unseen(later, advance({}, first), "0");
  expect(fresh.map((s) => s.stream)).toEqual(["2026-11-24"]);
});
