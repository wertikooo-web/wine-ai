# GPT-Live as a third realtime provider — Phase 0 report (29 Sep 2026)

Status: **parked until after the WineMD closed test (30 Sep)**. Decision: first a cheap spike, then (only if GPT-Live wins on voice quality) the full integration task.

## Current architecture (integration point)

- `src/realtime/providerRegistry.js` — ids `mock | gemini | grok | classic`; each definition = `{configured, model, voices, provider, rotationMode, supportedVoiceModes}`; `resolve(id)` → `{id, metadata, createSession}`; `getPublicCapabilities()` feeds provider selection. A new `gpt_live` entry would be additive here.
- Provider session contract used by `src/realtime/realtimeServer.js` (FROZEN, PR #76): `connect(log)`, `beginResponse(context)` per turn, `sendAudio(buffer)`, `interrupt(reason, context)`, `close()`/`destroySession()`, events via `onEvent`/`onSessionEvent` (`transcript.*`, `audio.start|chunk|end`, tool calls, usage). **realtimeServer owns the turn**: one generation per user turn, local VAD / tap-to-start / hold-to-talk, local speech-only barge-in, watchdog, per-turn rotation (Gemini `per_turn`, Grok `errors_only`).
- Gemini: 16 kHz PCM in, 24 kHz out; model = `GEMINI_LIVE_MODEL` env (code default `gemini-3.1-flash-live-preview`; the 3.8 launch model is set via Railway env — rollback = change that env var).
- Grok: OpenAI-Realtime-compatible protocol (`session.update`, `input_audio_buffer.*`, `response.create`, `response.done`), 16 kHz in / 24 kHz out, tools = function calls into our `search_wine_knowledge` etc.
- `OPENAI_API_KEY` already exists (Classic STT/Whisper); must stay optional.

## What GPT-Live is (from public search snippets only — official docs NOT readable from the sandbox)

- Model `gpt-live-1`, $0.05/min billed per second; backend model/tool usage billed separately.
- **New protocol, not the Realtime API**: `wss://api.openai.com/v1/live/sessions`, first message `session.start` (model, instructions, audio format, voice, delegation fixed at start); later `session.update` is sparse and can only change delegation settings.
- Audio: raw mono PCM16 LE **24 kHz** both ways (our browser capture sends 16 kHz → resampling needed on input; `pcm16Resampler.js` exists).
- **Full duplex**: the model decides when turns start/stop and listens while speaking. No per-response `response.done`. Interruption does not cancel backend work automatically.
- **Tools via delegation**: either an OpenAI-hosted Responses backend or *client delegation* — our app receives a delegation event (metadata only), builds the context itself, runs its agent/tools, returns the result.

## Blockers (why Phase 1 was not started)

1. **Contract mismatch (STOP condition of the task).** realtimeServer drives turns (beginResponse per generation, local VAD, local barge-in, per-response completion). GPT-Live owns turn-taking itself and has no per-response done. Fitting it into the existing contract means either an adapter that fakes per-turn generations from a continuous stream (fragile: stale events, double responses, mic not recovering) or a change to the frozen turn lifecycle. Needs an explicit design decision.
2. **Delegation ≠ function calling.** RAG must be reached via client delegation that calls the existing `search_wine_knowledge` path and keeps our own conversation context. Reuse is possible, but it is a new code path to ground-truth test.
3. **Official docs and API unreachable from the sandbox** (egress blocks developers.openai.com and api.openai.com; no `OPENAI_API_KEY`). The task forbids implementing from memory; contract tests could only run against a fake server.
4. **Timing.** Plan for 29 Sep: "No new providers". Any change to `providerRegistry`/realtimeServer a day before the WineMD test is avoidable risk.

## Next steps (after 30 Sep)

1. Zero-code check (10 min): listen to GPT-Live in the OpenAI Playground in RU / RO / EN, with Fetească Neagră, Rară Neagră, winery names. If it is not clearly better than Gemini/Grok in RU/RO, stop here.
2. Spike (1–2 h, standalone script, no WINE AI changes): connect to `/v1/live/sessions`, client delegation that calls the production knowledge API, measure connect / first audio / delegation latency, barge-in ×5, idle billing, cost per minute.
3. Only then: full integration task (flag `GPT_LIVE_ENABLED=false` default, provider id `gpt_live`) with the turn-ownership design decided up front.

Environment prerequisites for step 2/3 in the cloud session: allow `api.openai.com` and `developers.openai.com` in the environment network policy; add `OPENAI_API_KEY` as an environment secret.
