# Efficient Agent Workflow

These rules apply to Codex, Claude Code, OpenCode, Antigravity, and other coding agents working in this repository.

## Scope

- Work on one narrowly defined task at a time.
- Do not expand the task without explicit approval.
- Stop after the requested stage or checkpoint.
- Do not continue to a later stage automatically.

## Context loading

- Start with `AGENTS.md`, `PROJECT.md`, and the relevant route in `CONTEXT_MAP.md`.
- Read only files directly related to the current task.
- Do not scan the entire repository unless the task is an audit or the current evidence is insufficient.
- As a default, inspect no more than 8 relevant files before proposing a plan.
- If more files are required, briefly explain why before expanding the scope.
- Do not repeatedly reopen files whose relevant behavior has already been established in the current task.

## Before coding

Before changing code, provide:

1. A plan of no more than 10 lines.
2. The expected file list.
3. The tests that will be run.
4. Any production or migration risk.

Do not modify code until the requested analysis or approval checkpoint is complete.

## Implementation

- Make the smallest change that addresses the proven cause.
- Avoid unrelated refactoring, formatting, renaming, and cleanup.
- Preserve current public contracts unless the task explicitly changes them.
- Reuse existing services and abstractions before creating parallel implementations.
- Do not introduce another source of truth.

## Testing

During implementation:

- Run syntax checks and the narrowest relevant tests.
- Run related subsystem tests only when the narrow tests pass.
- Run the full repository suite only before commit, Pull Request, merge, deploy, or when the change affects broad shared infrastructure.
- Do not repeatedly investigate documented pre-existing failures unless the current task touches their code.
- Never report a test with zero assertions as meaningful coverage.
- Report tests that could not run and the exact reason.

## Known failures

Before investigating a failing test, check:

`docs/agent-context/KNOWN_TEST_ISSUES.md`

If the failure is already documented and the current diff does not touch the affected area:

- confirm that it is unchanged;
- report it briefly;
- do not spend task budget investigating it.

## Production safety

Never perform any of the following without explicit approval for that exact operation:

- production database write;
- destructive SQL;
- prune or cleanup;
- migration execution;
- deploy;
- merge;
- changing Railway variables;
- changing access permissions;
- using or rotating secrets.

Before any destructive or production operation:

1. Print the target environment.
2. Print the resolved mode and flags.
3. Print the planned number of affected rows or files.
4. Run a dry-run.
5. Confirm backup or rollback availability.
6. Request explicit approval.
7. Stop if the actual plan differs from the approved plan.

A destructive operation must not run after an earlier stage fails. For example, prune must not run when embedding creation fails.

Command-line safety flags must have tests for both enabled and disabled states.

## Agent cost and model use

- Use stronger models for architecture, difficult bugs, migrations, production risks, and final review.
- Use lower-cost models for mechanical edits, simple tests, formatting, import checks, and routine documentation.
- Avoid repeating repository-wide analysis already captured in current audit documents.
- Prefer short checkpoints over one long autonomous run.

## Final response

Keep the final response compact.

Include only:

1. Files changed.
2. Tests and results.
3. Remaining risks or unverified items.
4. Production actions performed, if any.
5. Branch, commit SHA, and Pull Request when applicable.

Do not repeat the entire implementation history.
