import { expect, test } from "bun:test";
import type { Followups, Loop } from "./followups";
import { syncTodos } from "./todo";

const loop = (extra: Partial<Loop> = {}): Loop => ({
  ask: "Sam · @sam: approve?",
  priority: "normal",
  anchors: [],
  opened: "2026-11-23T09:00:00.000Z",
  next: "2026-11-23T13:00:00.000Z",
  reminded: [],
  ...extra,
});
const closed = { at: "2026-11-23T10:00:00.000Z", reason: "replied in Slack" };
const ledger: Followups = {
  fresh: loop(),
  ticked: loop({ todo: { id: "t-ticked" } }),
  handled: loop({ closed, todo: { id: "t-handled" } }),
  quiet: loop({ silent: true }),
};
// An adapter that names new todos after their loop and reports t-ticked completed in the app.
const adapter = (script: string) => ({ todo: ["sh", "-c", script, "adapter"], timeout: 5000 });
const fake = adapter(`case "$1" in
  add) sed 's/.*"id":"\\([^"]*\\)".*/t-\\1/' ;;
  check) echo t-ticked ;;
esac`);

test("todos mirror loud loops both ways, and a failing adapter changes nothing", async () => {
  const now = Date.parse("2026-11-23T11:00:00Z");
  const synced = await syncTodos(".", fake, ledger, now);

  expect(synced.fresh!.todo).toEqual({ id: "t-fresh" });
  expect(synced.ticked).toMatchObject({
    closed: { reason: "done in todo app" },
    todo: { done: true },
  });
  expect(synced.handled!.todo).toEqual({ id: "t-handled", done: true });
  expect(synced.quiet!.todo).toBeUndefined();

  // Missing Reminders access must not read as every todo being done.
  expect(await syncTodos(".", adapter("exit 1"), ledger, now)).toEqual(ledger);
});
