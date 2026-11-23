import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const PRIORITIES = ["none", "low", "normal", "high", "emergency"] as const;
export const Priority = z.enum(PRIORITIES);
export type Priority = z.infer<typeof Priority>;
export const rank = (p: Priority) => PRIORITIES.indexOf(p);

const UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const Duration = z
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

const Name = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, "use lowercase letters, digits, - or _");
const Argv = z.array(z.string().min(1)).min(1);

const SlackSource = z
  .object({
    url: z.url().optional(), // workspace URL, e.g. https://acme.slack.com; enables message links
    channel_types: z.enum(["all", "dm", "group_dm", "partner", "internal"]).default("all"),
    mentions_only: z.boolean().default(false),
    thread_mentions: z.boolean().default(true), // also collect thread replies that mention me
    max_channels: z.number().int().positive().default(30),
    max_messages_per_channel: z.number().int().positive().default(10),
    exclude_channels: z.array(z.string()).default([]),
    // Channel name (with or without #) → minimum priority for its messages
    priority_channels: floors(z.string().min(1), (k) => k.replace(/^#/, "")),
  })
  .strict();
export type SlackSource = z.infer<typeof SlackSource>;

const GithubSource = z
  .object({
    repos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, "use owner/repo")).min(1),
    author: z.string().min(1).default("@me"),
  })
  .strict();
export type GithubSource = z.infer<typeof GithubSource>;

const LinearSource = z.object({}).strict();

const JiraSource = z
  .object({
    url: z.url(), // Jira Cloud site, e.g. https://acme.atlassian.net
  })
  .strict();
export type JiraSource = z.infer<typeof JiraSource>;

const Point = { lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) };

// National Weather Service alerts at a point (US only)
const WeatherSource = z.object(Point).strict();
export type WeatherSource = z.infer<typeof WeatherSource>;

const HackernewsSource = z
  .object({ min_points: z.number().int().positive().default(1000) })
  .strict();
export type HackernewsSource = z.infer<typeof HackernewsSource>;

const FeedSource = z.object({ url: z.url() }).strict(); // RSS or Atom
export type FeedSource = z.infer<typeof FeedSource>;

const TrafficSource = z
  .object({
    url: z.url(), // 511 site with the IBI developer API (/api/v2/get/event)
    areas: z.array(z.object({ ...Point, km: z.number().positive().default(10) }).strict()).min(1),
  })
  .strict();
export type TrafficSource = z.infer<typeof TrafficSource>;

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
        hackernews: byName(HackernewsSource),
        feed: byName(FeedSource),
      })
      .strict()
      .prefault({}),
    // Email → minimum priority for messages from that person, in any source
    vips: floors(z.email(), (k) => k.toLowerCase()),
    actions: z.record(Name, Action).default({}),
  })
  .strict();
export type Config = z.infer<typeof Config>;

/** Every configured source as kind/name, e.g. slack/acme. */
export const sourceIds = (cfg: Config) =>
  KINDS.flatMap((kind) => Object.keys(cfg.sources[kind]).map((name) => `${kind}/${name}`));

export function inWorkHours(work: Config["work_hours"], at: Date): boolean {
  if (!work) return true;
  const hour = at.getHours();
  return work.days.includes(DAYS[at.getDay()]!) && hour >= work.start && hour < work.end;
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
