/**
 * Daily agenda: opens the Outlook Calendar app's Home tab in the first Slack source that has
 * it, the way the desktop client does, reads today's events from its blocks, and sends one
 * notification. Exit codes match main.ts: 0 notified, 78 (Noon noop) no meetings today,
 * 1 failure.
 */
import { resolve } from "node:path";
import { loadConfig } from "./config";
import { clip } from "./llm";
import { notify, tellArgv } from "./notify";
import { serverEnv } from "./sources/slack";

const NOOP = 78;
const OUTLOOK_CALENDAR = "AFV5ECLBZ"; // Slack's app ID, the same in every workspace

type Block = {
  type: string;
  text?: { text?: string };
  accessory?: { type?: string };
};
type View = { hash: string; blocks: Block[] };
type Api = (method: string, args?: Record<string, string>) => Promise<any>;
export type Meeting = { title: string; start?: Date; end?: Date };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Slack's internal web API with this workspace's desktop session, which the Home tab needs. */
function slackApi(name: string): Api {
  const env = serverEnv(name, process.env, "");
  const token = env.SLACK_MCP_XOXC_TOKEN;
  if (!token) throw new Error(`agenda needs SLACK_${name.toUpperCase()}_XOXC_TOKEN/XOXD_TOKEN`);
  return async (method, args = {}) => {
    const form = new FormData();
    form.set("token", token);
    for (const [k, v] of Object.entries(args)) form.set(k, v);
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      body: form,
      headers: { cookie: `d=${env.SLACK_MCP_XOXD_TOKEN}`, "user-agent": env.SLACK_MCP_USER_AGENT! },
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as any;
    if (!json.ok) throw new Error(`slack/${name} ${method}: ${json.error ?? "failed"}`);
    return json;
  };
}

const epochs = (text: string) =>
  [...text.matchAll(/<!date\^(\d+)\^/g)].map((m) => new Date(Number(m[1]) * 1000));

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

const unescape = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The events on a Home tab render: sections with an event menu, `*<link|Title>* (_calendar_)`
 * on the first line and `<!date^start^…>-<!date^end^…>` on the second. */
export function meetings(blocks: Block[]): Meeting[] {
  return blocks
    .filter((b) => b.type === "section" && b.accessory?.type === "overflow" && b.text?.text)
    .map((b) => {
      const [head = "", ...rest] = b.text!.text!.split("\n");
      const label = head.match(/<[^|>]*\|([^>]*)>/)?.[1] ?? head.replace(/\(_[^)]*_\)/, "");
      const [start, end] = epochs(rest.join("\n"));
      return { title: unescape(label.replace(/[*_]/g, "")).trim() || "(no title)", start, end };
    })
    .sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0));
}

/** Today's Home tab, freshly published: opening the tab asks the app to re-render it, so wait
 * for a new hash that shows today's date. Undefined when this workspace lacks the app. */
async function todayBlocks(api: Api): Promise<Block[] | undefined> {
  const profile = await api("apps.profile.get", { app: OUTLOOK_CALENDAR }).catch((e) => {
    if (message(e).endsWith("app_not_found")) return undefined;
    throw e;
  });
  const bot = profile?.app_profile?.bot_user?.id;
  if (!profile?.app_profile?.is_installed || !bot) return undefined;

  const { channel } = await api("conversations.open", { users: bot, return_im: "true" });
  const info = await api("conversations.info", { channel: channel.id, return_app_home: "true" });
  const viewId: string | undefined = info.app_home?.home_view_id;
  if (!viewId) throw new Error("Outlook Calendar has no Home tab; open it once in Slack");
  const before: string | undefined = info.home_view?.hash;
  await api("apps.home.dispatchOpenEvent", {
    id: channel.id,
    type: "home",
    service_team_id: info.app_home.app_installed_team_id,
  });

  const today = new Date();
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(1000);
    const { view }: { view: View } = await api("views.get", { view_id: viewId });
    const [shown] = epochs(view.blocks.find((b) => b.type === "section")?.text?.text ?? "");
    if (view.hash !== before && shown && sameDay(shown, today)) return view.blocks;
  }
  throw new Error("Outlook Calendar didn't publish today's Home tab within 20s");
}

const hhmm = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

async function main(dryRun: boolean): Promise<number> {
  const root = resolve(import.meta.dir, "..");
  const cfg = loadConfig(root);
  const sources = Object.keys(cfg.sources.slack);
  if (sources.length === 0) throw new Error("agenda needs a slack source");

  let blocks: Block[] | undefined;
  for (const name of sources) if ((blocks = await todayBlocks(slackApi(name)))) break;
  if (!blocks) throw new Error(`Outlook Calendar isn't installed in slack/${sources.join(", ")}`);

  const list = meetings(blocks);
  if (list.length === 0) {
    console.log("no meetings today");
    return NOOP;
  }
  const title = `${list.length} meeting${list.length === 1 ? "" : "s"} today`;
  const body = clip(
    list
      .map((m) => {
        const time = m.start ? `${hhmm(m.start)}${m.end ? `–${hhmm(m.end)}` : ""}` : "all day";
        return `${time} ${clip(m.title, 60)}`;
      })
      .join("\n"),
    900,
  );
  console.log(`\n${title}\n${body}\n`);
  const argv = tellArgv(root, cfg.notify, "low", title, body);
  if (dryRun) {
    console.log(`would run: ${argv.slice(0, -1).join(" ")} <agenda>`);
    return 0;
  }
  const { delivered, detail } = await notify(argv);
  console.log(`tell: ${detail}`);
  return delivered ? 0 : 1;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== "--dry-run")) {
    console.error("usage: bun src/agenda.ts [--dry-run]");
    process.exit(2);
  }
  main(args.includes("--dry-run")).then(
    (code) => process.exit(code),
    (e) => {
      console.error(message(e));
      process.exit(1);
    },
  );
}
