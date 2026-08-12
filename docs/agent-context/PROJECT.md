# PROJECT.md

WINE AI is a realtime voice digital wine expert for Moldova, delivered through kiosks, tabletop devices, websites, and widgets.

## Primary runtime

```text
browser/device microphone
→ WebSocket transport
→ realtime session and generation orchestration
→ Gemini Live / Grok Voice / OpenAI Realtime adapter
→ optional tools and wine knowledge retrieval
→ streaming audio, transcript, visual events
→ playback and avatar
```

The native realtime provider owns speech understanding and speech generation inside the provider session. A separate `STT → LLM → TTS` chain is not the default architecture; it may be implemented only as an explicitly separate classic/fallback/benchmark mode.

## Product boundaries

- Supported conversation languages: Russian, Romanian, and English, with language detection rules defined by runtime code and persona configuration.
- Wine facts must come from confirmed knowledge or be clearly marked unavailable.
- The project must remain independent from any sibling repository.
- Knowledge retrieval augments realtime conversation through tools; it does not replace the realtime transport.

## Engineering workflow

All missions use the checkpoint, execution, independent-verifier, autonomy, and stop rules in `AGENT_WORKFLOW.md`. This product document does not define a second agent workflow.

Substantial WINE AI decisions remain senior/principal decisions: recommendations must be grounded in the product goal, observed system state, viable options, risks, acceptance criteria, and verification evidence. Assign work by outcome, constraints, invariants, acceptance criteria, and required proof rather than avoidable command-by-command scripts.

## Deferred strategic initiative: layered knowledge, provenance, and Knowledge Graph

The approved full analysis and roadmap is stored in:

`docs/architecture/WINE_KNOWLEDGE_STRATEGY_AND_ROADMAP.md`

It covers:

- four knowledge levels: canonical facts, Wine.md catalog, documents, controlled internet fallback;
- natural answer policy;
- answer modes;
- claim-level provenance;
- Answer Audit;
- PostgreSQL Knowledge Graph direction;
- Knowledge Studio;
- benchmark and implementation phases;
- lessons and reusable patterns from the parallel `wineMD-widget` project.

Status: initiative active by discrete tasks (not unpaused wholesale). Phase 1 (answer modes),
Phase 2 (Answer Audit + quality benchmark) and Phase 3 (Wine.md catalog hardening infrastructure)
are complete. The live Wine.md feed/API/export does not yet exist as a separate product dependency —
no temporary fake endpoint and no manual catalog fill; when Wine.md provides a real feed it will
plug into the existing sync contract (`WINEMD_CATALOG_URL` + `scripts/winemd-catalog-sync.js`)
without architecture changes. Next per roadmap: Phase 4, Entity relations v1.

## Source-of-truth order

1. Runtime code and tests.
2. API, WebSocket, provider, tool, database, and visual contracts.
3. `docs/architecture/STATE_OWNERSHIP.md` and architectural decisions.
4. This context documentation.
