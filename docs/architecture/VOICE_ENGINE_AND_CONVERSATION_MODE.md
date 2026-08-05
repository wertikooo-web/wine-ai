# Voice engine family and conversation mode

## Product decision

The first screen exposes two independent choices:

1. Voice engine family
   - `realtime`
   - `classic`
2. Conversation mode
   - `hold_to_talk`
   - `open_conversation`

Provider and model selection is not shown on the first screen.

Provider/model/voice selection belongs in Settings:

- Realtime: Gemini Live or Grok Voice, provider model, provider voice.
- Classic: STT provider/model, text LLM provider/model, TTS provider/model/voice.

Persona, role, style prompt, gender, language, memory, knowledge retrieval, tools, visual wine cards, analytics and safety policy remain shared across all four combinations.

## Supported matrix

| Engine family | Conversation mode | Interruption rule |
| --- | --- | --- |
| realtime | hold_to_talk | pressing the talk button while assistant output is active cancels the current generation and starts a new capture |
| realtime | open_conversation | confirmed user speech cancels the current generation and playback |
| classic | hold_to_talk | pressing the talk button while assistant output is active cancels STT/LLM/TTS work and starts a new capture |
| classic | open_conversation | confirmed user speech cancels STT/LLM/TTS work and playback |

## Canonical identifiers

```text
engineFamily: realtime | classic
conversationMode: hold_to_talk | open_conversation
```

Legacy UI labels such as `Tap-to-Start` or `Press-to-Talk` may be migrated, but runtime state must use the canonical identifiers above.

## State ownership

- Client UI owns the selected values before connection and displays them.
- Realtime Session Orchestrator owns session, turn, generation and cancellation lifecycle after connection.
- Provider Manager resolves the configured provider for the selected engine family.
- Provider adapters translate the shared session contract to provider-specific APIs.
- Playback Controller owns output queues and stopping playback.
- Knowledge Layer remains independent and is called through the existing grounded-answer/tool path.

The two choices must never create four separate lifecycle implementations.

## First-screen behavior

The first screen must:

- show `Realtime` and `Classic` as the top-level technology choice;
- show `Hold to Talk` and `Open Conversation` for either technology;
- show the current selection before connection;
- persist the selection using the existing settings mechanism;
- require clean disconnect/reconnect before changing an active session;
- disable an unavailable engine family with a useful reason;
- avoid exposing provider/model/voice controls.

## Settings behavior

Settings must show only controls relevant to the selected engine family.

Realtime settings:

- provider: Gemini Live or Grok Voice;
- model where supported;
- voice where supported;
- provider-specific options.

Classic settings:

- STT provider/model;
- text LLM provider/model;
- TTS provider/model/voice;
- sentence streaming and latency-related options that are safe to expose.

Shared settings remain outside both provider-specific groups.

## Classic pipeline contract

```text
microphone PCM
→ audio input mode controller
→ streaming STT
→ finalized transcript
→ shared Wine AI text reasoning + knowledge/tools
→ sentence-aware streaming TTS
→ existing audio output protocol
```

The implementation must not wait for the complete LLM answer before starting TTS. It must start TTS at safe sentence or phrase boundaries.

## Cancellation invariants

For every engine family and conversation mode:

- one user turn has one authoritative generation owner;
- cancellation invalidates the active output epoch;
- playback stops immediately;
- queued output is cleared;
- upstream work is aborted where the provider supports it;
- stale callbacks and late audio chunks are ignored;
- five consecutive interruptions work in one session;
- disconnect and End Conversation release all resources;
- no second or ghost voice can survive cancellation.

## Knowledge latency budget

The size of the knowledge base must not be sent to the model directly. Retrieval returns a bounded grounded context.

Initial targets:

- top chunks: 6 to 10;
- average retrieval latency: <= 250 ms;
- p95 retrieval latency: <= 700 ms;
- retrieval timeout must degrade explicitly rather than hang the turn;
- measure retrieval separately from STT, LLM and TTS latency.

## Out of scope

- Nemotron or local/self-hosted speech models;
- separate duplicated dashboards;
- a second independent barge-in state machine;
- provider selection on the first screen;
- merge, deploy or Railway variable changes without separate approval.
