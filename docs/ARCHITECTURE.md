# Architecture

## Boundary

`wine-ai-realtime` is an independent product. Its realtime transport/session core was originally proven in an unrelated children's-toy voice project; that is implementation history only. This repository does not import from, run inside, or depend on the runtime state of any other project — see `AGENTS.md`'s independence boundary.

## Target Pipeline

```text
Dashboard / avatar client (browser)
  -> PCM16 mono frames over WebSocket (push-to-talk)
  -> /realtime session router (turn/generation state machine)
  -> provider adapter (Gemini Live or mock)
  -> streaming audio response
  -> playback + avatar + latency metrics
```

## Session/turn state machine

One `generation` object is the single source of truth for a user turn (mirrors `currentGeneration` in `src/realtime/realtimeServer.js`):

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

Implementation detail: the transport core tracks this as `generation.status` (`pending` / `active` / `cancelled` / `completed` / `failed`) plus the presence/absence of an active tool call, rather than one single enum field — the state names above are the vocabulary used in logs, docs, and tests. Every transition is explicit; a stale `generationId` on a late provider event (e.g. a delayed `turnComplete`) is detected and dropped (`droppedProviderEvent`), never allowed to affect a newer turn. See `src/realtime/geminiLiveProvider.js`'s `shouldDropTurnCompleteWithoutModelOutput()` / `STALE_TURN_COMPLETE_GRACE_MS` for the concrete stale-turnComplete guard.

Every event carries `session_id`, `turn_id`, `generation_id`, `response_id`, and a server timestamp (`server_time_ms`).

## Audio input mode: push-to-talk

Gemini Live's `automaticActivityDetection` is disabled; the client sends explicit `input_audio.start` / `input_audio.end`, and the provider adapter sends explicit `activityStart`/`activityEnd` markers plus a short silence tail (`PTT_SILENCE_TAIL_MS`) so the last spoken phoneme is not truncated. This is a direct, unmodified port of the proven mechanism — see the migration plan for why open-mic VAD was deferred to a later iteration.

## Provider Adapter Contract

```js
{
  name,
  createSession(options) // -> session with: connect(), sendAudio(buffer), beginResponse(context),
                          //    endInput(context), sendText(text, context), interrupt(reason, context),
                          //    close() / destroySession(reason)
}
```

## Prompt assembly

`src/realtime/realtimePrompt.js` composes the system instruction from named blocks, each independently length-limited and hashed for observability:

- `[PERSONA]` — `src/persona/wineExpertPersona.js`'s core prompt (identity, tone, safety rules around alcohol).
- `[KNOWLEDGE CONTEXT]` — retrieved knowledge fragments for the current question (only present when the retrieval layer found relevant material — see `src/knowledge/search.js`); absent for small talk.
- `[CURRENT CONTEXT]` — session language, recent turns, session memory (wines discussed, preferences, budget, occasion).

## Tools (function calling)

`src/tools/*` implement the `toolHandlers` contract inherited unmodified from the transport core: `{ name: async ({args, generationId, turnId}) => structuredResult }`, wired into the provider the same way the original project wired its own (unrelated) local tools. See `src/realtime/geminiLiveProvider.js`'s `handleToolCall()`.

## Knowledge layer

```text
documents (knowledge/source/)
  -> cleaning
  -> chunking
  -> metadata (winery, region, grape, language, doc type, date, source URL, confidence, updated_at)
  -> index (knowledge/index/)
  -> search (src/knowledge/search.js)
  -> relevant fragments injected into [KNOWLEDGE CONTEXT]
```

Small talk / greetings never hit retrieval. Factual wine questions do. See `docs/ARCHITECTURE.md`'s "Metrics" section below and `npm run knowledge:index` / `npm run knowledge:check`.

## Avatar

`src/avatar/AvatarProvider.js` defines the interface (`connect / startSpeaking / stopSpeaking / setLanguage / disconnect / getStatus`). `src/avatar/providers/mockAvatarProvider.js` is the default — a static face with a speaking indicator, no external dependency, so the whole project runs with zero paid services.

## Metrics

Every session should record: time to first audio byte, end-to-end response latency, interruption handling, provider cost estimate (where available).

## Safety

- No real payment/financial actions, no medical claims about alcohol, no encouragement of excessive consumption — enforced in the persona prompt (`src/persona/wineExpertPersona.js`), not just as a convention.
- Do not invent producers, wines, awards, prices, or vintages — the persona prompt requires citing "I don't have confirmed data on that" when the knowledge layer returns nothing relevant.

## Product Rule

This repository must never be merged back into, or made to depend on, the project it borrowed its transport core from. Any future *shared* utility between the two must be an explicit, reviewed, standalone package — not a runtime coupling.
