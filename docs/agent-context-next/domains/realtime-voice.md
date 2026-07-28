# domains/realtime-voice.md — Realtime session lifecycle

## Trigger

When the task involves: WebSocket session, turn lifecycle, PTT, barge-in, interruption, audio pipeline, provider session management.

## Core files

- `src/realtime/realtimeServer.js` — the state machine (1900+ lines)
- `src/realtime/wsProtocol.js` — WebSocket framing (sendJson, sendBinary, createFrameParser)
- `src/realtime/pcm16Resampler.js` — sample-rate conversion
- `src/realtime/inputAudioResampling.js` — input resampling boundary

## Key concepts

### PTT (Push-to-Talk)

Input mode is PTT with explicit activity markers. Client sends:
1. `{ type: 'input_audio.start', turn_id: '...', mode: 'push_to_talk' }`
2. Binary audio frames (PCM16, 640 bytes per 20ms frame at 16kHz)
3. `{ type: 'input_audio.end' }`

Server sends `activityStart`/`activityEnd` markers plus a short silence tail (`PTT_SILENCE_TAIL_MS`) to the provider.

`automaticActivityDetection` is disabled for Gemini Live. Do not switch to VAD.

### Generation lifecycle

The `generation` object (tracked via `currentGeneration` in `realtimeServer.js`) is the single source of truth for a turn. One generation = one user turn.

- `generationId` identifies the turn throughout the pipeline.
- A stale `generationId` on a late provider event is detected and dropped (`droppedProviderEvent`).
- The PTT race fix (commit `a227d17`) removed status checks from `isActiveTurn` in `onBinary`, relying solely on `inputEndedAt` as the authoritative turn-end signal.

### Barge-in / interruption

- Client sends `session.interrupt` or the user presses "Stop response".
- Server sends `response.cancelled` with reason `interruption` or `new_input`.
- Provider session is rotated (new Gemini/Grok session for the next turn).
- Visual events: `visual.timeline.cancel` + `visual.reset` are emitted with the interrupted generation's ID.
- Client must stop playback immediately, not wait for server confirmation.

### Provider rotation

Each turn may create a new provider session (`rotationMode: per_turn` for Gemini). This avoids carrying state from interrupted or failed turns.

### Silence tail

After `input_audio.end`, the server appends `PTT_SILENCE_TAIL_MS` (300ms default) of silence frames to the provider, ensuring the last spoken phoneme is not truncated.

## Gotchas

- `inputEndedAt` is the only authoritative signal for "turn input is done" — not `generation.status`.
- `onBinary` (audio frame handler) checks `isActiveTurn` which only tests `currentGeneration && inputStartedAt && !inputEndedAt`.
- Audio frames after `inputEndedAt` are dropped with `reason=no_active_input`.
- Late provider events with a stale `generationId` are dropped.
- Every exit path must leave session state in a known, inspectable state.

## Tests

- `tests/realtimeLifecycle.test.js` — full lifecycle transitions
- `tests/pttRaceInputDrop.test.js` — PTT race regression
- `tests/pttFrameGuards.test.js` — frame guard tests
- `tests/geminiProviderInterrupt.test.js` — Gemini interrupt handling
- `tests/grokCancellationRace.test.js` — Grok cancellation race
- `tests/voiceModeTurnDetection.test.js` — voice mode turn detection
