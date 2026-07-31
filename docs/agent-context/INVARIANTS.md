# INVARIANTS.md

These rules are non-negotiable unless the project owner records an explicit architectural decision.

## Independence and safety

- No import, workspace, submodule, or symlink may make this repository depend on a sibling project.
- Never expose secrets or store real user audio unless explicit configuration enables it.
- Do not perform deploy, merge, production writes, access changes, or package publishing without explicit authorization.
- Preserve unrelated tracked and untracked work.

## Realtime architecture

- Native realtime is the primary voice architecture: audio streams into a realtime provider and audio streams back.
- Do not model the default runtime as an external mandatory `STT → LLM → TTS` cascade.
- A classic STT/LLM/TTS mode must be isolated as a separate mode with explicit ownership, configuration, metrics, and tests.
- Provider-specific behavior belongs behind provider adapters.

## State ownership

- Every mutable lifecycle state has exactly one authoritative owner.
- Session, input mode, user turn, generation, provider session, playback, and visual state must not have competing owners.
- Late or stale events are expected and must be rejected by correlation identifiers.
- Completion, interruption, cancellation, timeout, disconnect, and retry paths must be idempotent.
- Do not use arbitrary delays or speculative booleans instead of explicit state transitions.
- Follow `docs/architecture/STATE_OWNERSHIP.md` before changing lifecycle code.

## Input and audio

- PTT and Tap-to-Start are distinct supported modes. Their capture, activity detection, end-of-input, interruption, and cleanup rules must remain isolated.
- In PTT, button release/end-input is authoritative; provider response completion must not stop microphone input while PTT is still held.
- Tap-to-Start may use VAD and audio-processing settings defined for that mode; do not silently apply them to PTT.
- Prevent double resampling and reset per-turn audio state on the correct lifecycle transitions.

## Knowledge and factuality

- Knowledge retrieval is an optional realtime tool call, not the owner of the voice session.
- Empty or unavailable knowledge is a normal state; never fabricate producers, wines, vintages, awards, prices, or locations.
- Preserve public tool/search contracts or update all callers and tests together.

## Visual and playback

- Providers do not directly own visual lifecycle.
- Visual and playback events are scoped to the active generation and stale events must not affect a newer generation.
- The visual orchestrator remains the authority for generation-aware visual events.

## Deployment gate

Before merge or deploy, run the repository's current required gates, including missing-import validation, startup-without-admin-auth validation, smoke tests, and required CI. Never merge an import of an untracked or nonexistent file.
