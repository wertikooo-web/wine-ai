# AGENTS.md - wine-ai-realtime

## Scope

These rules apply to this repository. Follow direct user constraints first, then these project rules, then narrower instructions in subdirectories.

This repository is an independent product: a realtime voice digital expert on Moldovan wine. It reuses a realtime transport/session core that was originally proven in a separate, unrelated project (a children's voice toy lab). That origin is implementation history only — this repository must never import from, run inside, or depend on the runtime state of that other project.

## Independence boundary (hard rule)

- No `require`/`import` pointing outside this repository's own `src/`.
- No npm workspace, git submodule, or symlink back to any sibling project.
- This project must start, run, and be tested with only this directory checked out.
- Do not add child-toy domain concepts (parental controls, child profiles, learning games, riddles/stories) here. If a feature resembles one, stop and ask — it is very likely scope creep from the wrong product.

## Safety boundaries

- Start in read-only mode when the user requests analysis, audit, planning, or investigation.
- Change only files explicitly required by the task.
- Stop before production actions or external mutations unless the user explicitly approves them.
- External mutations include deploys, GitHub writes beyond the approved task, database writes, MCP or OAuth changes, access changes, package publishing, and remote configuration.
- Never use approval or sandbox bypass modes unless the user explicitly requests them for a proven isolated environment.
- Do not read, print, copy, summarize, or store secret values. Never print full `.env` files, tokens, passwords, private keys, cookies, OAuth stores, credentials, or authorization headers.
- Do not store real user audio or personal data without explicit configuration (`SAVE_AUDIO`, see `.env.example`) — off by default.

## Repository boundaries

Before editing:

- Confirm the repository root and current branch.
- Run `git status --short`.
- Preserve unrelated tracked and untracked work.
- Do not reset, clean, stash, move, delete, stage, or commit unrelated files without explicit permission.

## Architecture

Target flow:

```text
Browser dashboard / avatar client
  -> audio frames over WebSocket
  -> realtime session router (turn/generation state machine)
  -> provider adapter (Gemini Live / mock)
  -> streaming audio response
  -> playback, avatar, latency metrics
```

Maintain clear boundaries between:

- WebSocket protocol and frame parsing (`src/realtime/wsProtocol.js`);
- session and turn lifecycle (`src/realtime/realtimeServer.js`);
- provider adapters (`src/realtime/geminiLiveProvider.js`, `mockRealtimeProvider.js`);
- audio conversion and buffering (`src/realtime/pcm16Resampler.js`, `inputAudioResampling.js`);
- persona and prompt assembly (`src/persona/`, `src/realtime/realtimePrompt.js`);
- knowledge retrieval (`src/knowledge/`);
- wine tools / function-calling (`src/tools/`);
- session memory (`src/memory/sessionMemory.js`);
- avatar (`src/avatar/`);
- dashboard client (`public/`).

Provider-specific behavior belongs behind explicit adapters. Do not spread provider assumptions through unrelated code.

## Turn and session lifecycle

- A user turn must have one authoritative lifecycle (see `generation` object in `realtimeServer.js`).
- Local tools and provider events must not independently finalize the same turn.
- Completion, cancellation, timeout, interruption, and retry paths must be idempotent.
- Treat late provider events, duplicate completion signals, and stale callbacks as expected failure cases — a stale `generationId` must never affect a newer turn.
- Every exit path must leave session state in a known, inspectable state.
- Preserve correlation identifiers for sessions, turns, generations, responses, and provider events in every log line.
- Do not fix lifecycle problems with arbitrary delays when an explicit state transition or guard is possible.

## Audio pipeline

- Input mode is push-to-talk (PTT) with explicit activity markers, matching Gemini Live's `automaticActivityDetection: disabled`. Do not silently switch to automatic VAD — that is a distinct, unproven-in-this-codebase integration path and requires an explicit decision.
- Keep the accepted sample rate, channel count, sample format, and frame size explicit.
- Perform sample-rate conversion at the visible boundary where audio enters the pipeline (`onBinary` in `realtimeServer.js`), never via a hidden preload/monkey-patch.
- Do not introduce `node -r` runtime injection, monkey patches, or hidden bootstrap modules — an explicit in-code integration is always preferred here.
- Prevent silent double resampling. Reset/flush per-turn resampler state on the correct lifecycle events (new turn, interrupt, decode error).
- Measure latency for audio changes.

## Multilingual behavior

- Supported languages: Russian, Romanian, English. Auto-detect; reply in the language of the last clearly understood utterance; do not flap on a single foreign word or name.
- Winery/grape/region proper nouns (e.g. Fetească Neagră, Crama, Purcari) must not be treated as language-switch signals.

## Working style

- Prefer the smallest clear change that solves the demonstrated problem.
- Prefer readable control flow over hidden runtime behavior.
- Do not change providers, transport, persona, knowledge, and audio architecture in one change unless the task requires the combination.
- Record assumptions when behavior cannot be proven from code or tests.

## Required verification

```text
npm run smoke:http
npm run smoke:realtime
npm run smoke:language
npm run smoke:knowledge
npm test
```

Choose checks based on the changed surface. Report commands run, passed checks, skipped checks, failures, files changed, and remaining uncertainty.

## Completion bar

A task is complete only when:

- the approved scope is satisfied;
- unrelated work remains untouched;
- this repository still runs with zero dependency on any sibling project;
- syntax and relevant smoke checks pass;
- the final diff is reviewed;
- limitations and unverified assumptions are stated honestly.
