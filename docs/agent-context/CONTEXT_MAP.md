# CONTEXT_MAP.md

Load only the route relevant to the task.

## Realtime, PTT, Tap-to-Start, interruption, generation

Read:
- `docs/architecture/STATE_OWNERSHIP.md`
- `docs/agent-context/INVARIANTS.md`
- `docs/agent-context/domains/realtime-voice.md`
- relevant code and tests under `src/realtime/`, `public/`, and `tests/`

## Provider adapters

Read:
- `docs/architecture/STATE_OWNERSHIP.md`
- `docs/agent-context/domains/provider-adapters.md`
- `docs/agent-context/contracts/provider-adapter.md`
- provider registry, adapter implementation, and provider tests

## Knowledge, RAG, tools, KOS

Read:
- `docs/architecture/STATE_OWNERSHIP.md` when lifecycle or runtime state changes
- `docs/agent-context/domains/knowledge-retrieval.md`
- `docs/agent-context/contracts/knowledge-search.md`
- relevant `src/knowledge/`, `src/tools/`, `src/kos/`, schema, and tests

For work on layered knowledge routing, answer modes, claim provenance, Answer Audit, Wine.md catalog architecture, Knowledge Graph, Knowledge Studio, or Wine Intelligence, also read:

- `docs/architecture/WINE_KNOWLEDGE_STRATEGY_AND_ROADMAP.md`

That initiative is currently paused. Resume it only through an explicit task and start with Phase 0 reconciliation.

## Playback, avatar, visual events

Read:
- `docs/architecture/STATE_OWNERSHIP.md`
- `docs/agent-context/domains/visual-system.md`
- `docs/agent-context/contracts/visual-event.md`
- relevant visual, playback, frontend code, and tests

## Database and migrations

Read:
- `docs/agent-context/domains/database.md`
- current schema and migration code
- affected repository and integration tests

## Security, deployment, secrets

Read:
- `docs/agent-context/domains/security.md`
- `docs/agent-context/INVARIANTS.md`
- deployment workflow and configuration without exposing secret values

## Documentation-only task

Read `PROJECT.md`, this map, and the exact files being edited. Do not load all runtime domains unless needed to validate a claim.

Always finish with `VERIFICATION.md` and `DEFINITION_OF_DONE.md`.
