# domains/provider-adapters.md — Provider adapter contracts

## Trigger

When the task involves: Gemini, Grok, Mock, provider selection, voice configuration, model switching, provider-specific behavior.

## Core files

- `src/realtime/providerRegistry.js` — provider selection, capabilities API
- `src/realtime/geminiLiveProvider.js` — Gemini Live adapter
- `src/realtime/grokVoiceProvider.js` — Grok Voice (xAI) adapter
- `src/realtime/mockRealtimeProvider.js` — Mock adapter (no API key)
- `src/geminiVoices.js` — Gemini voice definitions
- `src/grokVoices.js` — Grok voice definitions

## Provider adapter contract

```js
{
  name,
  createSession(options) // -> session with: connect(), sendAudio(buffer), beginResponse(context),
                          //    endInput(context), sendText(text, context), interrupt(reason, context),
                          //    close() / destroySession(reason)
}
```

## Provider-specific behavior

### Gemini Live

- Model: `gemini-3.1-flash-live-preview` (default)
- Voice: configurable via Dashboard or env (`GEMINI_VOICE`)
- Rotation mode: `per_turn` (new session per turn by default)
- `automaticActivityDetection: disabled`
- Handles tool calls (function calling) natively
- Content tools enabled by default (`REALTIME_CONTENT_TOOLS`)
- Has `shouldDropTurnCompleteWithoutModelOutput()` / `STALE_TURN_COMPLETE_GRACE_MS` for stale-turnComplete guard

### Grok Voice (xAI)

- Model: `grok-voice-latest` (default)
- Voice: configurable via Dashboard or env (`GROK_VOICE_ID` or `XAI_VOICE_ID`)
- Rotation mode: `errors_only`
- Has `isBenignCancellationRace()` for handling benign cancellation errors
- Normalizes JSON schema for tool declarations (lowercase `type` field)
- URL: `wss://api.x.ai/v1/realtime` (default)

### Mock

- No API key required
- Synthetic tone response
- Used for development/testing
- Rotation mode: `errors_only`

## Provider selection

- Env var `REALTIME_PROVIDER` sets the default
- Per-session override via `session.start` message
- `normalizeProviderName()` maps `xai` → `grok`
- Dashboard shows available providers via `/api/voices` endpoint (calls `getPublicCapabilities()`)

## Voice configuration

- Server can override client-requested voice (`source=server_override`)
- Voice preserved across provider rotations within a session
- Prompt hash tracked for observability

## Tests

- `tests/grokProvider.test.js`
- `tests/grokCancellationRace.test.js`
- `tests/geminiProviderInterrupt.test.js`
- `tests/dashboardVoiceConfiguration.test.js`
- `tests/realtimeVoiceBinding.test.js`
- `tests/conversationSettings.test.js`
