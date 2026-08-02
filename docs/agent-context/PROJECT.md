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

Status: intentionally paused on 2026-08-02. Do not start implementation from the roadmap without a new explicit task. When resumed, begin with Phase 0 repository and production reconciliation.

## Source-of-truth order

1. Runtime code and tests.
2. API, WebSocket, provider, tool, database, and visual contracts.
3. `docs/architecture/STATE_OWNERSHIP.md` and architectural decisions.
4. This context documentation.
