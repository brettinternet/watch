import { hostname } from "node:os";
import type { Config, Priority } from "./config";

const HOST = hostname().split(".")[0];

const TYPE: Record<Priority, string> = {
  none: "info",
  low: "info",
  normal: "info",
  high: "warning",
  emergency: "failure",
};

export function tellArgv(
  root: string,
  cfg: Config["notify"],
  p: Priority,
  title: string,
  body: string,
  url?: string,
): string[] {
  return [
    "tell",
    "-C",
    root,
    "--json",
    "notify",
    "--title",
    `[${HOST}] ${title}`,
    "--type",
    TYPE[p],
    ...(url ? ["--url", url] : []),
    ...(cfg.args[p] ?? []),
    "--",
    body,
  ];
}

/**
 * Tell exit 0 is accepted and 5 is uncertain (it may have arrived), so neither is resent.
 * Anything else leaves the signals unhandled for the next run.
 */
export async function notify(argv: string[]): Promise<{ delivered: boolean; detail: string }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    delivered: code === 0 || code === 5,
    detail: `exit ${code} ${stdout.trim()} ${stderr.trim()}`.trim(),
  };
}
