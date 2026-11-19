# work

A [Noon](https://github.com/brettinternet/noon) job collects unread messages from each configured Slack workspace through [slack-mcp-server](https://github.com/korotovsky/slack-mcp-server). Claude or Pi groups and prioritizes them, and [Tell](https://github.com/brettinternet/tell) sends one Pushover notification at the matching priority. Optional actions run for matching items, such as starting an agent to investigate an incident.

## Setup

Each clone is configured separately:

1. Run `task init` to install tools and dependencies, create `.env.local`, and install hooks.
2. Add secrets to `.env.local`. `ACME` is the upper-cased source name:

    ```dotenv
    SLACK_ACME_XOXC_TOKEN=xoxc-...
    SLACK_ACME_XOXD_TOKEN=xoxd-...
    PUSHOVER_TOKEN=...
    PUSHOVER_USER=...
    ```

    Copy the stealth `xoxc`/`xoxd` tokens from a logged-in browser session ([how](https://github.com/korotovsky/slack-mcp-server/blob/master/docs/01-authentication-setup.md)), or set `SLACK_ACME_XOXP_TOKEN` instead. Any other `SLACK_ACME_*` key reaches only that workspace's server, as `SLACK_MCP_*`.

3. Configure sources in `triage.local.yaml`:

    ```yaml
    llm:
        agent: pi # default: claude
        args: [--model, sonnet]
    sources:
        acme: { kind: slack }
        side: { kind: slack, channel_types: dm, mentions_only: true }
    ```

4. Run `task setup:tell` to route this clone's notifications to Pushover in `.git/tell.yaml`.
5. Run `task triage -- --dry-run` to preview a run without notifying, running actions, or recording anything. The first run against a large workspace is slow while the user and channel caches sync.
6. Run `noon enable` to schedule the job. The Noon service's `PATH` must include `mise` and the agent CLI.

## Per-clone files

All of these are gitignored or live in `.git`.

| File                | Purpose                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `.env.local`        | Secrets                                                                                                    |
| `triage.local.yaml` | Sources, LLM, and actions. Deep-merges over [`triage.yaml`](triage.yaml); lists replace.                   |
| `triage.local.md`   | Extra instructions appended to [`prompts/triage.md`](prompts/triage.md), e.g. who you are and what you own |
| `.noon.vars`        | `TRIAGE_SCHEDULE` (default `*/15 * * * *`) and `TRIAGE_TIMEOUT` (default `10m`)                            |
| `.git/tell.yaml`    | Notification routing                                                                                       |
| `.git/noon.yaml`    | Private Noon jobs                                                                                          |

## How a run works

1. Collect unread messages from every source. Messages stay unread in Slack.
2. Drop messages already handled, using per-channel cursors in `.state/cursors.json`, and messages older than `max_age`.
3. One LLM call with no tools groups messages into items with a priority and category. The overall priority is the highest item's priority.
4. If it reaches `notify.min_priority`, run `tell notify` with `notify.args[priority]`. Emergency priority repeats every `retry` until acknowledged or `expire`.
5. Run matching actions, then advance the cursors.

A run exits 0 after notifying, 78 (a Noon noop) when nothing reached the threshold, and 1 on any failure. A failed notification leaves its messages for the next run. If the LLM fails, a fallback lists counts per channel, with DMs at normal priority. The run still exits 1, and Noon's `on_failure` hook notifies once when a streak of failures starts.

## Actions

```yaml
# triage.local.yaml
actions:
    investigate:
        when: { categories: [incident], min_priority: high }
        run: noon -C ~/dev/service run investigate --detach --key "$TRIAGE_KEY" --data -
```

An action runs from this repository with the item as JSON on stdin (`action`, `key`, `priority`, `category`, `reason`, `signals`). Its environment has `TRIAGE_ACTION`, `TRIAGE_KEY`, `TRIAGE_PRIORITY`, and `TRIAGE_CATEGORY`, plus `PATH`, `HOME`, and locale variables, and no secrets. `TRIAGE_KEY` is stable per item, so Noon's `--key` drops duplicates.

The receiving job reads the item from `$NOON_EVENT_FILE`:

```yaml
# ~/dev/service/.git/noon.yaml
jobs:
    investigate:
        requests: each
        prompt: |
            Read the triage item in the JSON file at $NOON_EVENT_FILE. Investigate it in this
            repository, then report the likely cause and a recommended fix. Change nothing.
```

Message text is untrusted input. Give that agent read-only tools.

## Development

`task test`, `task typecheck`, and `task triage -- --dry-run`. To add a source kind, add its schema to `src/config.ts`, a collector in `src/sources/`, and a case in `collect()` in `src/main.ts`.
