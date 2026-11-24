import { minimalEnv } from "./actions";
import type { Config } from "./config";
import type { Followups, Loop } from "./followups";

type Todo = Config["followups"] & { todo: string[] };

/** Runs the adapter with one verb and returns its stdout; a nonzero exit throws. */
async function call(root: string, cfg: Todo, args: string[], stdin?: object): Promise<string> {
  const proc = Bun.spawn([...cfg.todo, ...args], {
    cwd: root,
    env: minimalEnv(process.env), // the ask is untrusted message text
    stdin: stdin ? new Blob([JSON.stringify(stdin)]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: cfg.timeout,
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`todo ${args[0]} exited ${code}: ${err.trim().slice(-300)}`);
  return out;
}

const warn = (e: unknown) => console.error(e instanceof Error ? e.message : String(e));
const loud = (l: Loop) => !l.closed && !l.silent;

/**
 * Mirrors loud follow-ups to a todo app through the `followups.todo` adapter. A todo completed
 * or deleted in the app closes its loop; a loop closed here completes its todo; an open loud loop
 * without a todo gets one, due at its first reminder. A failed call is logged and retried next
 * run, and a loop keeps watch's own reminders until it has a todo.
 */
export async function syncTodos(
  root: string,
  cfg: Todo,
  ledger: Followups,
  now: number,
): Promise<Followups> {
  const next = { ...ledger };
  const at = new Date(now).toISOString();
  const set = (id: string, loop: Loop, what: string) => {
    next[id] = loop;
    console.log(`follow-up ${id} ${what}: ${loop.ask}`);
  };

  const tracked = Object.entries(next).filter(([, l]) => !l.closed && l.todo && !l.todo.done);
  if (tracked.length) {
    try {
      const out = await call(root, cfg, ["check", ...tracked.map(([, l]) => l.todo!.id)]);
      const finished = new Set(out.split("\n").map((s) => s.trim()));
      for (const [id, l] of tracked)
        if (finished.has(l.todo!.id))
          set(
            id,
            { ...l, closed: { at, reason: "done in todo app" }, todo: { ...l.todo!, done: true } },
            "closed (done in todo app)",
          );
    } catch (e) {
      warn(e);
    }
  }

  for (const [id, l] of Object.entries(next)) {
    if (!l.closed || !l.todo || l.todo.done) continue;
    try {
      await call(root, cfg, ["done", l.todo.id]);
      set(id, { ...l, todo: { ...l.todo, done: true } }, "todo completed");
    } catch (e) {
      warn(e);
    }
  }

  for (const [id, l] of Object.entries(next)) {
    if (!loud(l) || l.todo) continue;
    try {
      const { ask, priority, url, next: due } = l;
      const todo = (await call(root, cfg, ["add"], { id, ask, priority, url, due })).trim();
      if (!todo || todo.includes("\n"))
        throw new Error(`todo add printed no single id: ${todo.slice(0, 80)}`);
      set(id, { ...l, todo: { id: todo } }, "added to todo app");
    } catch (e) {
      warn(e);
    }
  }
  return next;
}
