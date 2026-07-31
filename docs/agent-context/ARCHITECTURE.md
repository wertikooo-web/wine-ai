# ARCHITECTURE.md

## Primary runtime

```text
Browser/device microphone
→ PCM/audio frames over WebSocket
→ realtime session router and generation state
→ provider adapter (Gemini Live / Grok Voice / OpenAI Realtime / Mock)
→ optional tool calls and wine knowledge retrieval
→ streaming audio, transcript, and generation-scoped visual events
→ playback, avatar, and latency metrics
```

The primary architecture is native realtime. Speech understanding and speech synthesis may happen inside the provider session. A separate `STT → LLM → TTS` pipeline is allowed only as an explicitly isolated classic, fallback, or benchmark mode.

## Lifecycle

The session router owns server-side session, turn, and generation orchestration. Provider events, tool results, playback, and visuals may report into that lifecycle but must not independently finalize or revive it.

Every late event must be checked against current correlation identifiers. Completion, cancellation, interruption, timeout, retry, and disconnect are explicit and idempotent transitions.

## Input modes

- **PTT:** explicit press/start and release/end-input. Provider completion is not the authority for ending microphone input.
- **Tap-to-Start:** persistent listening mode with its own VAD/activity and cleanup rules.

Do not share speculative mode booleans or end-of-input assumptions between these modes. Shared transport is acceptable; shared ownership is not.

## Provider adapters

Provider-specific session creation, audio transport, activity markers, response events, interruption, cleanup, tools, and model/voice configuration remain behind adapters and the provider registry.

## Knowledge

Knowledge search is invoked through tools when the realtime assistant needs confirmed information. Retrieval results augment the current generation and prompt/tool context. Retrieval does not own audio capture, provider session, turn completion, or playback.

## Visuals and playback

Visual events and playback are generation-scoped consumers. Providers do not directly own visual lifecycle. The visual orchestrator translates conversation/tool events into the public visual protocol.

## Source of truth

Use runtime code and tests for exact current states and payloads. Before changing lifecycle behavior, follow `docs/architecture/STATE_OWNERSHIP.md`.
