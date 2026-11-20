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

const Name = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, "use lowercase letters, digits, - or _");
const Argv = z.array(z.string().min(1)).min(1);

const SlackSource = z
  .object({
    kind: z.literal("slack"),
    url: z.url().optional(), // workspace URL, e.g. https://acme.slack.com; enables message links
    channel_types: z.enum(["all", "dm", "group_dm", "partner", "internal"]).default("all"),
    mentions_only: z.boolean().default(false),
    thread_mentions: z.boolean().default(true), // also collect thread replies that mention me
    max_channels: z.number().int().positive().default(30),
    max_messages_per_channel: z.number().int().positive().default(10),
    exclude_channels: z.array(z.string()).default([]),
  })
  .strict();
export type SlackSource = z.infer<typeof SlackSource>;

const GithubSource = z
  .object({
    kind: z.literal("github"),
    repos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, "use owner/repo")).min(1),
    author: z.string().min(1).default("@me"),
  })
  .strict();
export type GithubSource = z.infer<typeof GithubSource>;

const LinearSource = z.object({ kind: z.literal("linear") }).strict();

const JiraSource = z
  .object({
    kind: z.literal("jira"),
    url: z.url(), // Jira Cloud site, e.g. https://acme.atlassian.net
  })
  .strict();
export type JiraSource = z.infer<typeof JiraSource>;

const Source = z.discriminatedUnion("kind", [SlackSource, GithubSource, LinearSource, JiraSource]);
export type Source = z.infer<typeof Source>;

const Action = z
  .object({
    when: z
      .object({
        categories: z.array(Name).min(1).optional(),
        sources: z.array(Name).min(1).optional(),
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
    // No separators: a name is also the SLACK_<NAME>_ (or LINEAR_, JIRA_) env prefix, which must not overlap.
    sources: z
      .record(z.string().regex(/^[a-z][a-z0-9]{0,31}$/, "use lowercase letters and digits"), Source)
      .default({}),
    actions: z.record(Name, Action).default({}),
  })
  .strict();
export type Config = z.infer<typeof Config>;

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
      if (!(s in parsed.data.sources)) throw new Error(`actions.${name}: unknown source ${s}`);
    }
  }
  return parsed.data;
}
