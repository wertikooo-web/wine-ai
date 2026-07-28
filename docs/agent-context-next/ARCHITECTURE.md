# ARCHITECTURE.md — Agent Context

## Pipeline

```text
Browser dashboard / avatar client
  → PCM16 mono frames over WebSocket (push-to-talk)
  → /realtime session router (src/realtime/realtimeServer.js)
  → provider adapter (Gemini Live / Grok Voice / Mock)
  → streaming audio response + transcript + visual events
  → playback + avatar + latency metrics
```

## Session/turn state machine

One `generation` object is the single source of truth for a user turn:

```text
IDLE
LISTENING            (input_audio.start received, streaming mic frames)
USER_TURN_FINALIZING (input_audio.end received, resampler tail flushed)
THINKING             (provider connecting / waiting for first model event)
TOOL_RUNNING         (a wine tool function-call is in flight)
ASSISTANT_SPEAKING   (audio.chunk streaming to the client)
INTERRUPTING         (session.interrupt or barge-in received)
RECOVERING           (provider timeout/failure — rotating to a fresh provider session)
CLOSED               (socket closed)
```

Implementation: `generation.status` (`pending` / `active` / `cancelled` / `completed` / `failed`) plus the presence/absence of an active tool call. Every transition is explicit; a stale `generationId` on a late provider event is detected and dropped (`droppedProviderEvent`), never allowed to affect a newer turn.

Every event carries `session_id`, `turn_id`, `generation_id`, `response_id`, and `server_time_ms`.

See `src/realtime/realtimeServer.js` for the implementation.

## Provider Adapter Contract

```js
{
  name,
  createSession(options) // -> session with: connect(), sendAudio(buffer), beginResponse(context),
                          //    endInput(context), sendText(text, context), interrupt(reason, context),
                          //    close() / destroySession(reason)
}
```

Three adapters exist:
- `geminiLiveProvider.js` — Gemini Live (Google)
- `grokVoiceProvider.js` — Grok Voice (xAI)
- `mockRealtimeProvider.js` — Mock (no API key, synthetic tone)

Selection via `REALTIME_PROVIDER` env var or per-session override. Registry in `providerRegistry.js`.

Provider-specific behavior belongs behind explicit adapters. Do not spread provider assumptions through unrelated code.

## Prompt assembly

`src/realtime/realtimePrompt.js` composes the system instruction from named blocks:
- `[PERSONA]` — `src/persona/wineExpertPersona.js`'s core prompt
- `[KNOWLEDGE CONTEXT]` — retrieved knowledge fragments (when retrieval finds relevant material)
- `[CURRENT CONTEXT]` — session language, recent turns, session memory

## Audio input mode: push-to-talk

Gemini Live's `automaticActivityDetection` is disabled. Client sends explicit `input_audio.start` / `input_audio.end`. Provider adapter sends `activityStart`/`activityEnd` markers plus a short silence tail (`PTT_SILENCE_TAIL_MS`) so the last spoken phoneme is not truncated.

Do not silently switch to automatic VAD — that is a distinct, unproven-in-this-codebase integration path.

## Audio pipeline

- Input: PCM16 mono, 16kHz (configurable), 20ms frames (640 bytes)
- Sample-rate conversion at the visible boundary where audio enters the pipeline (`onBinary` in `realtimeServer.js`)
- No `node -r` runtime injection, monkey patches, or hidden bootstrap modules
- Per-turn resampler state reset on: new turn, interrupt, decode error

## Visual event system

`src/visual/visualOrchestrator.js` emits `visual.*` events scoped to `generation_id`. Event types defined in `src/visual/visualProtocol.js`:
- `visual.reset`, `visual.avatar.state`, `visual.wine.show/hide`
- `visual.aromas.show`, `visual.pairing.show`, `visual.region.show`
- `visual.card.show`, `visual.commerce.show`
- `visual.timeline.complete`, `visual.timeline.cancel`

`AVATAR_STATES`: `idle`, `greeting`, `listening`, `thinking`, `speaking`, `enthusiastic`, `presenting_wine`, `pointing`, `confirming_order`, `goodbye`.

Two renderers consume these events:
1. `public/visual/VisualStoryController.mjs` — DOM/CSS renderer (shipped, working)
2. Rive character renderer — planned, not yet built (see `.claude/skills/winemd-rive/`)

No LLM provider ever touches visual events directly. The orchestrator is the only thing that knows about turns/generations/interruption.

## Knowledge layer

```text
documents (knowledge/source/)
  → loader.js (frontmatter parsing + paragraph chunking)
  → index.js (buildIndex() → knowledge/index/index.json)
  → search.js (keyword IDF + optional semantic pgvector via RRF)
  → tools/searchWineKnowledge.js (function calling)
  → [KNOWLEDGE CONTEXT] block in prompt
```

Search modes: `keyword` (default), `hybrid` (keyword + semantic), `disabled` (kill switch). Persisted to Postgres `app_settings` table. Runtime-toggleable from Dashboard.

Small talk / greetings never hit retrieval. Factual wine questions do.

## KOS (Knowledge Object Store)

Separate pipeline for structured knowledge ingestion:
- `src/kos/sources/` — website crawling (Dashboard "Add website")
- `src/kos/extraction/` — document → candidate facts
- `src/kos/validation/` — candidate verification
- `src/kos/publication/` — fact publication to `kos_knowledge_facts`
- `src/kos/db/kosSchema.js` — schema creation (runs at boot)

**Critical known state (as of 2026-07-24 audit):** The KOS ingestion pipeline writes raw crawled pages to `kos_source_documents` but extraction → validation → publication stages are not wired into any scheduled job or route. Crawled content is invisible to the assistant's answer path. The `search()` function only reads from `knowledge/index/index.json`.

## Tools (function calling)

`src/tools/*` implement the `toolHandlers` contract:
```js
{ name: async ({args, generationId, turnId}) => structuredResult }
```

Registered in `src/tools/index.js` and passed to every provider session via `createProviderFactory()` in `src/server.js`.

Current tools: `search_wine_knowledge`, `search_winery`, `compare_grape_varieties`, `recommend_wine_pairing`, `get_wine_route_information`, `update_session_memory`.

## Multilingual behavior

Supported languages: Russian, Romanian, English (+ French, Italian, Spanish, German, Chinese, Japanese for detection). Auto-detect; reply in the language of the last clearly understood utterance. Do not flap on a single foreign word or name.

Winery/grape/region proper nouns (e.g. Fetească Neagră, Crama, Purcari) must not be treated as language-switch signals.

## Safety

- No real payment/financial actions, no medical claims about alcohol, no encouragement of excessive consumption.
- Do not invent producers, wines, awards, prices, or vintages — cite "I don't have confirmed data on that" when the knowledge layer returns nothing relevant.
- Enforced in the persona prompt (`src/persona/wineExpertPersona.js`), not just as a convention.

## Mandatory state ownership rules

Before changing realtime, voice, provider, playback, visual, session, or knowledge lifecycle code, read:

- `docs/architecture/STATE_OWNERSHIP.md`

The rules in that document are mandatory and override convenience-driven local implementations.