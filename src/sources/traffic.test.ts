import { expect, test } from "bun:test";
import { type Event, eventsToSignals } from "./traffic";

const now = Date.parse("2026-11-23T16:00:00Z");
const event = (ID: number, extra: Partial<Event> = {}): Event => ({
  ID,
  RoadwayName: "Main St",
  DirectionOfTravel: "Northbound",
  Description: "Crash, all lanes blocked",
  Reported: now / 1000 - 600,
  StartDate: now / 1000 - 600,
  Latitude: 40.05, // ~5.6 km north of the area
  Longitude: -100,
  EventType: "accidentsAndIncidents",
  IsFullClosure: true,
  Severity: "Unknown",
  ...extra,
});

test("only started major or full-closure non-roadwork events with an end in an area pass", () => {
  const source = { url: "https://511.example.gov", areas: [{ lat: 40, lon: -100, km: 8 }] };
  const signals = eventsToSignals(
    "home",
    source,
    [
      event(1),
      event(2, { IsFullClosure: false, Severity: "Major" }),
      event(3, { Latitude: 40.2, LatitudeSecondary: 40.01, LongitudeSecondary: -100 }),
      event(4, { Latitude: 40.1 }), // ~11 km away
      event(5, { EventType: "roadwork" }),
      event(6, { IsFullClosure: false, Severity: "Moderate" }),
      event(7, { StartDate: now / 1000 + 3600 }),
    ],
    now,
  );
  expect(signals.map((s) => s.stream)).toEqual(["1", "2", "3"]);
});
