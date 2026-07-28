# contracts/provider-adapter.md — Provider adapter interface

## Interface

```js
{
  name: string,
  createSession(options: {
    apiKey: string,
    model: string,
    voice: string,
    instructions: string,
    tools: Array<{functionDeclarations: Array}>,
    onEvent: (event: object) => void,
    onBinary: (buffer: Buffer) => void,
    onError: (error: Error) => void,
    onOpen: () => void,
    onClose: (code: number, reason: string) => void,
    rotationMode: 'per_turn' | 'errors_only',
  }) => Session
}
```

## Session interface

```js
{
  connect: () => Promise<void>,
  sendAudio: (buffer: Buffer) => void,
  sendText: (text: string, context: object) => void,
  beginResponse: (context: object) => void,
  endInput: (context: object) => void,
  interrupt: (reason: string, context: object) => void,
  close: () => void,
  destroySession: (reason: string) => void,
}
```

## Event types (provider → server)

### Audio events
- `audio.chunk` — PCM16 audio buffer
- `audio.done` — audio response complete

### Turn events
- `turn.start` — model started responding
- `turn.complete` — model finished response
- `turn.cancelled` — response cancelled

### Tool events
- `function.call` — tool invocation request
- `function.result` — tool result

### Activity events
- `activityStart` — input activity detected
- `activityEnd` — input activity ended

### Error events
- `error` — provider error
- `session.closed` — session closed

## Provider-specific implementations

### Gemini Live (`geminiLiveProvider.js`)

- Model: `gemini-3.1-flash-live-preview` (default)
- Rotation mode: `per_turn` (new session per turn)
- `automaticActivityDetection: disabled`
- Content tools enabled by default (`REALTIME_CONTENT_TOOLS`)
- Stale-turnComplete guard: `shouldDropTurnCompleteWithoutModelOutput()` / `STALE_TURN_COMPLETE_GRACE_MS`

### Grok Voice (`grokVoiceProvider.js`)

- Model: `grok-voice-latest` (default)
- Rotation mode: `errors_only`
- Benign cancellation race handling: `isBenignCancellationRace()`
- JSON schema normalization for tool declarations (lowercase `type`)
- URL: `wss://api.x.ai/v1/realtime` (default)

### Mock (`mockRealtimeProvider.js`)

- No API key required
- Synthetic tone response
- Rotation mode: `errors_only`

## Contract rules

- Provider-specific behavior belongs behind explicit adapters
- Do not spread provider assumptions through unrelated code
- `createSession()` must return a session with the interface above
- Session must handle connection errors gracefully
- `interrupt()` must stop audio generation immediately
- `close()` / `destroySession()` must clean up resources

## Tests

- `tests/grokProvider.test.js` — Grok adapter behavior
- `tests/grokCancellationRace.test.js` — Grok cancellation race
- `tests/geminiProviderInterrupt.test.js` — Gemini interrupt handling
- `tests/dashboardVoiceConfiguration.test.js` — voice configuration
- `tests/realtimeVoiceBinding.test.js` — voice binding
- `tests/conversationSettings.test.js` — conversation settings
