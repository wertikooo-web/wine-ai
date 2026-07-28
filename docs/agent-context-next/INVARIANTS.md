# INVARIANTS.md — Non-negotiable rules

Every rule here is classified `PRODUCT_INVARIANT` or `SAFETY_OR_PRODUCTION_INVARIANT`. Removing or relaxing any of these requires an explicit written decision by the project owner.

---

## Independence (PRODUCT_INVARIANT)

- No `require`/`import` pointing outside this repository's own `src/`.
- No npm workspace, git submodule, or symlink back to any sibling project.
- This project must start, run, and be tested with only this directory checked out.
- Do not add child-toy domain concepts (parental controls, child profiles, learning games, riddles/stories).
- This repository must never be merged back into, or made to depend on, the project it borrowed its transport core from.

## Safety boundaries (SAFETY_OR_PRODUCTION_INVARIANT)

- Start in read-only mode when the user requests analysis, audit, planning, or investigation.
- Change only files explicitly required by the task.
- Stop before production actions or external mutations unless the user explicitly approves them.
- External mutations include: deploys, GitHub writes beyond the approved task, database writes, MCP or OAuth changes, access changes, package publishing, remote configuration.
- Do not read, print, copy, summarize, or store secret values. Never print full `.env` files, tokens, passwords, private keys, cookies, OAuth stores, credentials, or authorization headers.
- Do not store real user audio or personal data without explicit configuration (`SAVE_AUDIO`) — off by default.

## Repository hygiene (SAFETY_OR_PRODUCTION_INVARIANT)

- Before editing: confirm the repository root and current branch. Run `git status --short`.
- Preserve unrelated tracked and untracked work.
- Do not reset, clean, stash, move, delete, stage, or commit unrelated files without explicit permission.

## Deployment gate (SAFETY_OR_PRODUCTION_INVARIANT)

Before merging or deploying any commit, ALL of the following MUST pass:

1. `npm run check:missing-imports` — no local `require`/`import` references an untracked file.
2. `node --test tests/startupNoAdminAuth.test.js` — server starts without the admin auth module.
3. `npm run test:smoke` — all smoke tests pass against the freshly started server.
4. The CI workflow (`startup-smoke`) is green.

The commit that broke production (b8b8748) would have been caught by check #1 alone. Do not skip or disable these checks.

## Unfinished feature policy (SAFETY_OR_PRODUCTION_INVARIANT)

If a feature branch introduces a `require` or `import` of a file that does not yet exist, that commit must **never be merged to `main`** or deployed to production. Complete the feature in the same branch (all required files committed). Run `npm run check:missing-imports` to verify. Only then merge/deploy.

Never commit a "skeleton" import that relies on a developer having the file locally but untracked — this is exactly the class of bug that caused the 2026-07-26 production outage.

## Audio pipeline (PRODUCT_INVARIANT)

- Input mode is push-to-talk (PTT) with explicit activity markers.
- Do not silently switch to automatic VAD — that is a distinct, unproven-in-this-codebase integration path and requires an explicit decision.
- Perform sample-rate conversion at the visible boundary where audio enters the pipeline, never via a hidden preload/monkey-patch.
- Do not introduce `node -r` runtime injection, monkey patches, or hidden bootstrap modules.
- Prevent silent double resampling. Reset/flush per-turn resampler state on the correct lifecycle events.

## Turn lifecycle (ARCHITECTURE_CONTRACT)

- A user turn must have one authoritative lifecycle (the `generation` object in `realtimeServer.js`).
- Local tools and provider events must not independently finalize the same turn.
- Completion, cancellation, timeout, interruption, and retry paths must be idempotent.
- A stale `generationId` must never affect a newer turn.
- Every exit path must leave session state in a known, inspectable state.
- Do not fix lifecycle problems with arbitrary delays when an explicit state transition or guard is possible.

## Knowledge retrieval (ARCHITECTURE_CONTRACT)

- `search(query, options)` is the public contract for `src/tools/*`. Its signature must not change without updating all callers.
- Retrieval fallback: if semantic search errors, fall back to keyword-only rather than throwing.
- The knowledge base starting empty is a normal, expected state — not an error.

## Visual event protocol (ARCHITECTURE_CONTRACT)

- No LLM provider ever touches visual events directly.
- The orchestrator is the only thing that knows about turns/generations/interruption.
- Visual events are scoped to `generation_id`. A stale event must never affect a newer generation.
- `html` field is forbidden in visual events (XSS prevention).
- Rive character is a second, alternative renderer for the same `visual.*` events — not a replacement for the existing DOM/CSS renderer.

## Personality and factuality (PRODUCT_INVARIANT)

- Never invent producers, wines, awards, prices, or vintages.
- Distinguish fact, opinion, and recommendation.
- Say "I don't have confirmed data on that" when the knowledge layer returns nothing relevant.
- No medical claims about alcohol. No encouragement of excessive consumption.

## State ownership invariant

Every mutable lifecycle state has exactly one authoritative owner.

UI, audio capture, transport, session orchestration, provider management, playback, visuals, and knowledge retrieval must not independently mutate each other's internal lifecycle state.

No feature or bugfix may introduce a second source of truth for active session, turn, generation, provider instance, playback, or visual state.