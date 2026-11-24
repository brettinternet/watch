import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const PRIORITIES = ["none", "low", "normal", "high", "emergency"] as const;
export const Priority = z.enum(PRIORITIES);
export type Priority = z.infer<typeof Priority>;
export const rank = (p: Priority) => PRIORITIES.indexOf(p);

const UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
export const Duration = z
  .string()
  .regex(/^\d+[smhd]$/, "use a duration like 30s, 3m, 24h, or 2d")
  .transform((s) => Number(s.slice(0, -1)) * UNITS[s.at(-1) as keyof typeof UNITS]);

export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Minimum priority for a VIP or channel. Empty means normal; emergency would page on every message. */
const Floor = z
  .enum(["low", "normal", "high"])
  .nullable()
  .transform((p) => p ?? "normal");
/** Keys normalized with `key`, so lookups need no case or prefix handling. */
const floors = (keys: z.ZodString | z.ZodEmail, key: (k: string) => string) =>
  z
    .record(keys, Floor)
    .default({})
    .transform((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [key(k), v])));

/** A 5-field cron expression or nickname, in local time. */
const Cron = z.string().refine(
  (s) => {
    try {
      return Bun.cron.parse(s) !== null;
    } catch {
      return false;
    }
  },
  { message: "use a cron expression like 0 9 * * 1-5" },
);

/** Fields every source accepts. */
const Common = {
  // Trusted guidance for triaging this source's signals, e.g. what to look for or skip
  instructions: z.string().min(1).optional(),
  // Collect at the first run after each occurrence instead of every run
  schedule: Cron.optional(),
};

const Name = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, "use lowercase letters, digits, - or _");
const Argv = z.array(z.string().min(1)).min(1);

const SlackSource = z
  .object({
    url: z.url().optional(), // workspace URL, e.g. https://acme.slack.com; enables message links
    channel_types: z.enum(["all", "dm", "group_dm", "partner", "internal"]).default("all"),
    mentions_only: z.boolean().default(false),
    thread_mentions: z.boolean().default(true), // also collect thread replies that mention me or are in my threads
    max_channels: z.number().int().positive().default(30),
    max_messages_per_channel: z.number().int().positive().default(10),
    exclude_channels: z.array(z.string()).default([]),
    // Channel name (with or without #) → minimum priority for its messages
    priority_channels: floors(z.string().min(1), (k) => k.replace(/^#/, "")),
    ...Common,
  })
  .strict();
export type SlackSource = z.infer<typeof SlackSource>;

const GithubSource = z
  .object({
    repos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, "use owner/repo")).min(1),
    author: z.string().min(1).default("@me"),
    events: z
      .array(z.enum(["merged", "ready", "review"]))
      .min(1)
      .default(["merged"]),
    ...Common,
  })
  .strict();
export type GithubSource = z.infer<typeof GithubSource>;

const LinearSource = z.object(Common).strict();

const JiraSource = z
  .object({
    url: z.url(), // Jira Cloud site, e.g. https://acme.atlassian.net
    ...Common,
  })
  .strict();
export type JiraSource = z.infer<typeof JiraSource>;

const Point = { lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) };

// National Weather Service alerts at a point (US only)
const WeatherSource = z.object({ ...Point, ...Common }).strict();
export type WeatherSource = z.infer<typeof WeatherSource>;

const HackernewsSource = z
  .object({ min_points: z.number().int().positive().default(1000), ...Common })
  .strict();
export type HackernewsSource = z.infer<typeof HackernewsSource>;

const FeedSource = z.object({ url: z.url(), ...Common }).strict(); // RSS or Atom
export type FeedSource = z.infer<typeof FeedSource>;

const TrafficSource = z
  .object({
    url: z.url(), // 511 site with the IBI developer API (/api/v2/get/event)
    areas: z.array(z.object({ ...Point, km: z.number().positive().default(10) }).strict()).min(1),
    ...Common,
  })
  .strict();
export type TrafficSource = z.infer<typeof TrafficSource>;

const EarthquakeSource = z
  .object({
    ...Point,
    km: z.number().positive().default(150),
    min_magnitude: z.number().positive().default(4),
    ...Common,
  })
  .strict();
export type EarthquakeSource = z.infer<typeof EarthquakeSource>;

const AirQualitySource = z.object({ ...Point, ...Common }).strict(); // US AQI forecast from Open-Meteo
export type AirQualitySource = z.infer<typeof AirQualitySource>;

const DependabotSource = z
  .object({ owners: z.array(z.string().min(1)).min(1), ...Common })
  .strict();
export type DependabotSource = z.infer<typeof DependabotSource>;

// CISA Known Exploited Vulnerabilities whose vendor or product contains any match
const KevSource = z.object({ match: z.array(z.string().min(1)).min(1), ...Common }).strict();
export type KevSource = z.infer<typeof KevSource>;

// No separators: a name is also the SLACK_<NAME>_ (LINEAR_, JIRA_) env prefix, which must not
// overlap. Names are unique per kind, so one workspace can share a name across kinds.
const SourceName = z.string().regex(/^[a-z][a-z0-9]{0,31}$/, "use lowercase letters and digits");
const byName = <T extends z.ZodType>(source: T) => z.record(SourceName, source).default({});

export const KINDS = [
  "slack",
  "github",
  "linear",
  "jira",
  "weather",
  "traffic",
  "earthquake",
  "airquality",
  "dependabot",
  "kev",
  "hackernews",
  "feed",
] as const;

const Action = z
  .object({
    when: z
      .object({
        categories: z.array(Name).min(1).optional(),
        sources: z.array(z.string()).min(1).optional(), // kind/name, e.g. slack/acme
        min_priority: Priority.default("high"),
      })
      .strict(),
    run: z.union([z.string().min(1), Argv]),
    timeout: Duration.prefault("30s"),
  })
  .strict();
export type Action = z.infer<typeof Action>;

export const Config = z
  .object({
    version: z.literal(1),
    max_age: Duration.prefault("24h"),
    max_text: z.number().int().positive().default(800),
    llm: z
      .object({
        agent: z.enum(["claude", "pi", "command"]).default("claude"),
        args: z.array(z.string()).default([]),
        command: Argv.optional(),
        timeout: Duration.prefault("3m"),
      })
      .strict()
      .refine((l) => l.agent !== "command" || l.command, {
        message: "llm.command is required when llm.agent is command",
      }),
    categories: z.record(Name, z.string().min(1)),
    // Outside these local hours only notify.after_hours_min_priority notifies; the rest is held
    // for the first run back in work hours. Omit to treat every hour as work hours.
    work_hours: z
      .object({
        days: z.array(z.enum(DAYS)).min(1),
        start: z.number().int().min(0).max(23),
        end: z.number().int().min(1).max(24),
      })
      .strict()
      .refine((w) => w.start < w.end, { message: "start must be before end" })
      .optional(),
    notify: z
      .object({
        min_priority: Priority.default("normal"),
        after_hours_min_priority: Priority.default("high"),
        args: z.partialRecord(Priority, z.array(z.string())).default({}),
      })
      .strict(),
    sources: z
      .object({
        slack: byName(SlackSource),
        github: byName(GithubSource),
        linear: byName(LinearSource),
        jira: byName(JiraSource),
        weather: byName(WeatherSource),
        traffic: byName(TrafficSource),
        earthquake: byName(EarthquakeSource),
        airquality: byName(AirQualitySource),
        dependabot: byName(DependabotSource),
        kev: byName(KevSource),
        hackernews: byName(HackernewsSource),
        feed: byName(FeedSource),
      })
      .strict()
      .prefault({}),
    // Email → minimum priority for messages from that person, in any source
    vips: floors(z.email(), (k) => k.toLowerCase()),
    actions: z.record(Name, Action).default({}),
    followups: z
      .object({
        // Mirrors loud follow-ups to a todo app; see scripts/reminders for the protocol
        todo: Argv.optional(),
        timeout: Duration.prefault("30s"),
        // Work hours before the first reminder (at most 1h for high asks), then between reminders
        first: Duration.prefault("4h"),
        again: Duration.prefault("8h"),
        // Reminders per follow-up before it expires; 0 leaves reminding to the digest or todo app
        reminders: z.number().int().min(0).prefault(2),
        // Cron, local time: one "Still open" notification listing every waiting follow-up, at the
        // first work-hours run after each occurrence. Follow-ups then stay open until handled or 7d.
        digest: Cron.optional(),
      })
      .strict()
      .prefault({}),
  })
  .strict();
export type Config = z.infer<typeof Config>;

/** Every configured source keyed as kind/name, e.g. slack/acme. */
export const sourceEntries = (cfg: Config) =>
  KINDS.flatMap((kind) =>
    Object.entries(cfg.sources[kind]).map(([name, source]) => [`${kind}/${name}`, source] as const),
  );

export const sourceIds = (cfg: Config): string[] => sourceEntries(cfg).map(([id]) => id);

/** Whether a source runs now: unscheduled, never collected, or its schedule fired since `last`. */
export function due(schedule: string | undefined, last: number | undefined, now: number): boolean {
  if (!schedule || last === undefined) return true;
  const next = Bun.cron.parse(schedule, last);
  return next !== null && next.getTime() <= now;
}

export function inWorkHours(work: Config["work_hours"], at: Date): boolean {
  if (!work) return true;
  const hour = at.getHours();
  return work.days.includes(DAYS[at.getDay()]!) && hour >= work.start && hour < work.end;
}

const STEP_MS = 5 * 60_000;

/** The time `ms` of work hours after `from`; the clock stops outside them. */
export function afterWork(work: Config["work_hours"], from: number, ms: number): number {
  if (!work) return from + ms;
  let at = from;
  for (let left = ms; left > 0; at += STEP_MS) if (inWorkHours(work, new Date(at))) left -= STEP_MS;
  return at;
}

export const CONFIG_FILES = ["triage.yaml", "triage.local.yaml"];

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Objects merge by key; arrays and scalars from `over` replace `base`. */
export function merge(base: unknown, over: unknown): unknown {
  if (!isPlain(base) || !isPlain(over)) return over === undefined ? base : over;
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

export function loadConfig(root: string): Config {
  let raw: unknown = {};
  for (const name of CONFIG_FILES) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    raw = merge(raw, Bun.YAML.parse(readFileSync(path, "utf8")) ?? {});
  }
  // Sources used to be keyed by name with a kind field.
  const sources = isPlain(raw) && isPlain(raw.sources) ? raw.sources : {};
  const flat = Object.entries(sources).filter(([, s]) => isPlain(s) && "kind" in s);
  if (flat.length) {
    const moves = flat.map(([n, s]) => `sources.${n} → sources.${(s as Plain).kind}.${n}`);
    throw new Error(`group sources by kind and drop kind: ${moves.join(", ")}`);
  }
  const parsed = Config.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new Error(`invalid config (${CONFIG_FILES.join(" + ")}):\n${issues.join("\n")}`);
  }
  for (const [name, action] of Object.entries(parsed.data.actions)) {
    for (const c of action.when.categories ?? []) {
      if (!(c in parsed.data.categories)) throw new Error(`actions.${name}: unknown category ${c}`);
    }
    for (const s of action.when.sources ?? []) {
      if (!sourceIds(parsed.data).includes(s))
        throw new Error(`actions.${name}: unknown source ${s}; use kind/name, e.g. slack/acme`);
    }
  }
  return parsed.data;
}
