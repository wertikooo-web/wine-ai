# DEFINITION_OF_DONE.md

A task is complete only when ALL of the following are true:

## Scope

- The approved scope is satisfied.
- Unrelated work remains untouched.
- This repository still runs with zero dependency on any sibling project.

## Verification

- Syntax and relevant smoke checks pass.
- The final diff is reviewed.
- Limitations and unverified assumptions are stated honestly.

## Deployment gates (before merge/deploy)

1. `npm run check:missing-imports` — no local `require`/`import` references an untracked file.
2. `node --test tests/startupNoAdminAuth.test.js` — server starts without the admin auth module.
3. `npm run test:smoke` — all smoke tests pass against the freshly started server.
4. The CI workflow (`startup-smoke`) is green.

## Working style

- Prefer the smallest clear change that solves the demonstrated problem.
- Prefer readable control flow over hidden runtime behavior.
- Do not change providers, transport, persona, knowledge, and audio architecture in one change unless the task requires the combination.
- Record assumptions when behavior cannot be proven from code or tests.

## Test strategy

- **During development:** run only tests for the files/modules you changed.
- **Before closing a stage:** run the full test suite once:
  ```text
  npm test
  npm run test:smoke
  ```
- Choose checks based on the changed surface during iteration.
- No Blind Mocking: avoid mocking internal utility files in unit tests unless they make remote network requests or perform database changes.
- Mandatory Live Reload Check: after editing files affecting API routes or frontend scripts, restart the server and verify with a real HTTP check.
- No Unnecessary Test Execution: do NOT run the entire test suite or launch multiple parallel/unnecessary test runs during development unless explicitly requested.

## Architecture sanity check

For any change affecting stateful or asynchronous behavior:

- state ownership is documented;
- no competing source of truth was introduced;
- no duplicate lifecycle path was introduced;
- no speculative boolean workaround was added;
- no arbitrary timer is used for synchronization;
- stale callbacks are rejected;
- regression tests cover the changed lifecycle;
- `docs/architecture/STATE_OWNERSHIP.md` remains satisfied.