# AGENTS.next.md — Agent instructions (v2)

## Scope

These rules apply to this repository. Follow direct user constraints first, then these project rules, then narrower instructions in subdirectories.

This repository is an independent product: a realtime voice digital expert on Moldovan wine. It reuses a realtime transport/session core that was originally proven in a separate, unrelated project (a children's voice toy lab). That origin is implementation history only — this repository must never import from, run inside, or depend on the runtime state of that other project.

## Context loading

**Load in order:**
1. `docs/agent-context-next/PROJECT.md` — what the project is, key paths
2. `docs/agent-context-next/ARCHITECTURE.md` — components, state machines, contracts
3. `docs/agent-context-next/INVARIANTS.md` — safety, production, and architectural invariants
4. `docs/agent-context-next/CONTEXT_MAP.md` — progressive loading guide for task types
5. `docs/agent-context-next/DEFINITION_OF_DONE.md` — completion criteria and verification

**For domain-specific tasks, load the relevant domain file from `docs/agent-context-next/domains/`:**
- `realtime-voice.md` — WebSocket session, turn lifecycle, PTT, barge-in
- `provider-adapters.md` — Gemini, Grok, Mock adapter contracts
- `knowledge-retrieval.md` — search, embeddings, KOS pipeline
- `visual-system.md` — visual orchestrator, events, B-roll
- `database.md` — schema, migrations, KOS tables
- `security.md` — secrets, SSRF, deployment gates

**For interface contracts, load from `docs/agent-context-next/contracts/`:**
- `provider-adapter.md` — provider adapter interface
- `visual-event.md` — visual event protocol
- `knowledge-search.md` — knowledge search contract

## Independence boundary (hard rule)

- No `require`/`import` pointing outside this repository's own `src/`.
- No npm workspace, git submodule, or symlink back to any sibling project.
- This project must start, run, and be tested with only this directory checked out.
- Do not add child-toy domain concepts (parental controls, child profiles, learning games, riddles/stories) here. If a feature resembles one, stop and ask — it is very likely scope creep from the wrong product.
- This repository must never be merged back into, or made to depend on, the project it borrowed its transport core from.

## Safety boundaries

- Start in read-only mode when the user requests analysis, audit, planning, or investigation.
- Change only files explicitly required by the task.
- Stop before production actions or external mutations unless the user explicitly approves them.
- External mutations include: deploys, GitHub writes beyond the approved task, database writes, MCP or OAuth changes, access changes, package publishing, remote configuration.
- Do not read, print, copy, summarize, or store secret values. Never print full `.env` files, tokens, passwords, private keys, cookies, OAuth stores, credentials, or authorization headers.
- Do not store real user audio or personal data without explicit configuration (`SAVE_AUDIO`) — off by default.

## Repository boundaries

Before editing:
- Confirm the repository root and current branch.
- Run `git status --short`.
- Preserve unrelated tracked and untracked work.
- Do not reset, clean, stash, move, delete, stage, or commit unrelated files without explicit permission.

## Turn and session lifecycle

- A user turn must have one authoritative lifecycle (the `generation` object in `realtimeServer.js`).
- Local tools and provider events must not independently finalize the same turn.
- Completion, cancellation, timeout, interruption, and retry paths must be idempotent.
- A stale `generationId` must never affect a newer turn.
- Every exit path must leave session state in a known, inspectable state.
- Do not fix lifecycle problems with arbitrary delays when an explicit state transition or guard is possible.

## Audio pipeline

- Input mode is push-to-talk (PTT) with explicit activity markers.
- Do not silently switch to automatic VAD.
- Perform sample-rate conversion at the visible boundary where audio enters the pipeline.
- Do not introduce `node -r` runtime injection, monkey patches, or hidden bootstrap modules.
- Prevent silent double resampling. Reset/flush per-turn resampler state on the correct lifecycle events.

## Multilingual behavior

- Supported languages: Russian, Romanian, English (+ French, Italian, Spanish, German, Chinese, Japanese for detection).
- Auto-detect; reply in the language of the last clearly understood utterance; do not flap on a single foreign word or name.
- Winery/grape/region proper nouns must not be treated as language-switch signals.

## Working style

- Prefer the smallest clear change that solves the demonstrated problem.
- Prefer readable control flow over hidden runtime behavior.
- Do not change providers, transport, persona, knowledge, and audio architecture in one change unless the task requires the combination.
- Record assumptions when behavior cannot be proven from code or tests.

## Required verification

- **During development:** run only tests for the files/modules you changed.
- **Before closing a stage:** run full test suite once:
  ```text
  npm test
  npm run test:smoke
  ```
- Choose checks based on the changed surface during iteration.
- No Blind Mocking: avoid mocking internal utility files unless they make remote network requests.
- Mandatory Live Reload Check: after editing files affecting API routes or frontend scripts, restart server and verify with real HTTP check.
- No Unnecessary Test Execution: do NOT run entire test suite during development unless explicitly requested.

## Completion bar

A task is complete only when:
- the approved scope is satisfied;
- unrelated work remains untouched;
- this repository still runs with zero dependency on any sibling project;
- syntax and relevant smoke checks pass;
- the final diff is reviewed;
- limitations and unverified assumptions are stated honestly.

## Deployment gate

Before merging or deploying any commit, ALL of the following must pass:

1. `npm run check:missing-imports` — no local `require`/`import` references an untracked file.
2. `node --test tests/startupNoAdminAuth.test.js` — server starts without the admin auth module.
3. `npm run test:smoke` — all smoke tests pass against the freshly started server.
4. The CI workflow (`startup-smoke`) is green.

The commit that broke production (b8b8748) would have been caught by check #1 alone. Do not skip or disable these checks.

## Unfinished feature policy

If a feature branch introduces a `require` or `import` of a file that does not yet exist, that commit must **never be merged to `main`** or deployed to production. Complete the feature in the same branch (all required files committed). Run `npm run check:missing-imports` to verify. Only then merge/deploy.

Never commit a "skeleton" import that relies on a developer having the file locally but untracked — this is exactly the class of bug that caused the 2026-07-26 production outage.
