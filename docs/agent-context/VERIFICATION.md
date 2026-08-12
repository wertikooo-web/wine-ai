# VERIFICATION.md

Choose verification by changed surface. Do not claim checks that were not run.

## During implementation

- Run syntax and the narrowest relevant unit or integration tests.
- After API-route or frontend-runtime changes, restart the process and verify a real HTTP or UI path.
- Avoid blind mocks of internal boundaries when the real module can run locally.
- Inspect logs for session, turn, generation, response, and provider correlation IDs when lifecycle behavior is involved.

## Realtime changes

Verify the affected modes separately:

- PTT start, held input, release, response, repeated turn, interruption, and disconnect.
- Tap-to-Start activation, VAD/end-of-input, response, interruption, repeated turn, and disconnect.
- Stale provider events and stale audio/visual chunks are rejected.
- Provider completion does not incorrectly terminate active PTT input.
- Playback and microphone ownership do not produce double audio.

## Provider changes

Verify adapter contract compatibility, cleanup, interruption, error/timeout behavior, and a mock or isolated provider test. Do not require live paid credentials for every local iteration; report when live verification remains outstanding.

## Knowledge and tools

Verify empty-index behavior, relevant retrieval, no-answer behavior, tool payload shape, fallback behavior, and factual non-fabrication.

## Repository gate selection

Apply the cost and gate-selection rules in `AGENT_WORKFLOW.md`. Run the narrowest relevant checks first. The broad runtime gates are:

```text
npm run check:missing-imports
node --test tests/startupNoAdminAuth.test.js
npm test
npm run test:smoke
```

Run the full set only when the change affects the broad runtime contract or required CI invokes it. Documentation-only changes do not require runtime suites unless they alter an executable contract. Confirm the required checks for the changed surface are green. If scripts change, use current `package.json` as source of truth and update this document.

## Final report

State:

- files changed;
- checks run and results;
- checks skipped and why;
- remaining uncertainty;
- whether deployment or merge was performed.
