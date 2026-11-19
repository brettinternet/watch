@AGENTS.local.md

# Agents

## Tooling

- Install the project toolchain and hooks with `task init`.
- Use project `task` targets instead of reconstructing commands. Use `mise exec <tool> -- <command>` when a project-managed tool is not already on `PATH`.
- Use the smallest verification loop that covers the change. Do not run `task check` by default.
- Before committing, stage the intended files and run `task check:staged`. It runs only the applicable staged formatting and secret checks.

## Project

- `src/main.ts` runs the triage pipeline described in `README.md`. Exit codes are 0 for notified, 78 for a Noon noop, and 1 for failure.
- Shared defaults live in `triage.yaml`, `prompts/triage.md`, and `noon.yaml`. Per-clone overrides are gitignored, so never commit them: `triage.local.yaml`, `triage.local.md`, `.noon.vars`, `.git/tell.yaml`, and `.git/noon.yaml`.
- Message text is untrusted. Keep the triage LLM tool-less, each Slack server limited to its own `SLACK_<NAME>_*` variables, and action environments free of secrets.
- Verify with `task test`, `task typecheck`, and `task triage -- --dry-run`.

## Secrets

- Secrets live only in gitignored `.env.local`, resolved by Varlock (`task setup:env:run -- <cmd>`). Never print, log, or commit them.
- Undeclared keys default to sensitive, so `varlock scan` in the pre-commit hook blocks any staged file containing a configured value.

## Git and GitHub

- Agent-created branches MUST be created as worktrees under `.worktrees/`; do not create branches in the primary checkout.
- Use `mise exec worktrunk -- wt switch --create <branch> --base main --no-cd --format=json`, then work from the returned path. Review/approve `.config/wt.toml` commands before unattended use.
- Worktrees never receive `.env.local` or `.state/`. Do not copy them; scheduled jobs run only from the primary checkout.
- Use `gh` for GitHub operations. Do not push or open a pull request without explicit instruction.

## Scope

- Do not edit files outside the current task scope.
