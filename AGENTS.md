# AGENTS.md — WINE AI

## Product boundary

WINE AI is an independent realtime voice wine expert for Moldova, delivered through devices, websites, and widgets. Its primary voice path is native realtime:

```text
microphone → WebSocket session → realtime provider → streaming audio response
                                      ↘ tools / knowledge retrieval when needed
```

Do not describe or implement the default path as a mandatory `STT → LLM → TTS` cascade. A classic cascade may exist only as an explicitly separate fallback, benchmark, or experimental mode.

## Required mission startup

1. Read `docs/agent-context/AGENT_WORKFLOW.md` — the sole workflow and authority source of truth.
2. Read `.agents/CHECKPOINT.md` — the sole current-mission checkpoint — and reconcile it with current evidence.
3. Read `docs/agent-context/PROJECT.md` and choose one route from `docs/agent-context/CONTEXT_MAP.md`.
4. Load only the relevant domain documents, contracts, code, and tests.
5. Before lifecycle work, read `docs/architecture/STATE_OWNERSHIP.md` and identify the owners of affected state.
6. Finish with the surface-specific checks in `docs/agent-context/VERIFICATION.md` and the repository criteria in `docs/agent-context/DEFINITION_OF_DONE.md`.

Do not create duplicate workflow instructions or additional checkpoint files. Apply the independent verifier, bounded self-check, fan-out, autonomy, escalation, and cost rules exactly as defined in `docs/agent-context/AGENT_WORKFLOW.md`.

## Non-negotiable product invariants

- The repository must not depend on sibling projects or import files outside its boundary.
- One user turn and one generation have one authoritative lifecycle owner.
- Stale provider, playback, and visual events cannot affect a newer generation.
- Provider-specific behavior stays inside provider adapters.
- Knowledge retrieval is an optional tool; it does not replace realtime transport.
- PTT and Tap-to-Start are distinct supported input modes with separate state and completion rules.
- Do not add arbitrary timing workarounds or parallel sources of truth instead of explicit state transitions.
- Never expose secrets or store real user audio unless explicit configuration enables it.
- Never fabricate wines, producers, vintages, prices, awards, or locations.

The complete product and runtime invariants are in `docs/agent-context/INVARIANTS.md`.

## Scope and evidence

Make the smallest change that satisfies the approved goal. Runtime code, tests, and observed behavior outrank Markdown summaries. Preserve unrelated work. Never claim verification, merge, deployment, or production state without evidence.
