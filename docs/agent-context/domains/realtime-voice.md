# Realtime voice

Primary path: microphone audio → WebSocket → session/turn/generation orchestrator → realtime provider → streaming audio response.

Treat PTT and Tap-to-Start as separate modes with separate activation, end-of-input, VAD, interruption, and cleanup rules. In PTT, release/end-input is authoritative; provider response completion must not drop microphone frames while the button is still held.

Before edits, identify owners for capture, input mode, session, turn, generation, provider session, playback, and visuals using `docs/architecture/STATE_OWNERSHIP.md`.

Reject stale events by correlation ID. Make disconnect, interruption, timeout, completion, and retry idempotent. Prefer explicit transitions over timers or duplicate flags.
