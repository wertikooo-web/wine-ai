# PROJECT.md — Wine AI Realtime

## What

Realtime voice-and-text digital expert on Moldovan wine. Users talk to it in Russian, Romanian, English, French, Italian, Spanish, German, Chinese, or Japanese. It detects language automatically.

## Repository

Independent product. Reuses a realtime transport/session core originally proven in an unrelated children's-voice-toy project (`lunara-realtime`). That origin is implementation history only — this repository must never import from, run inside, or depend on the runtime state of that other project.

## Independence boundary (PRODUCT_INVARIANT)

- No `require`/`import` pointing outside this repository's own `src/`.
- No npm workspace, git submodule, or symlink back to any sibling project.
- This project must start, run, and be tested with only this directory checked out.
- Do not add child-toy domain concepts (parental controls, child profiles, learning games, riddles/stories) here.

## Stack

- Node.js ≥ 20
- WebSocket (custom protocol, no framework)
- Provider adapters: Gemini Live, Grok Voice (xAI), Mock
- PostgreSQL (Railway addon) for KOS tables, search mode persistence, app settings
- Knowledge retrieval: keyword (IDF-weighted) + optional semantic (pgvector + Gemini embeddings) via Reciprocal Rank Fusion
- Frontend: vanilla JS/DOM (no React, no Next.js)
- Deployment: Railway via `railway up --detach`; CI via GitHub Actions (`startup-smoke`)

## Key paths

| Area | Path |
|---|---|
| Server entry | `src/server.js` |
| Realtime core | `src/realtime/realtimeServer.js` |
| WS protocol | `src/realtime/wsProtocol.js` |
| Provider adapters | `src/realtime/geminiLiveProvider.js`, `grokVoiceProvider.js`, `mockRealtimeProvider.js` |
| Provider registry | `src/realtime/providerRegistry.js` |
| Audio pipeline | `src/realtime/pcm16Resampler.js`, `inputAudioResampling.js` |
| Prompt assembly | `src/realtime/realtimePrompt.js` |
| Persona | `src/persona/wineExpertPersona.js`, `personaStore.js`, `profileRegistry.js` |
| Knowledge retrieval | `src/knowledge/search.js`, `searchMode.js` |
| Knowledge indexing | `src/knowledge/index.js`, `loader.js` |
| Embeddings | `src/knowledge/embeddings.js` |
| Knowledge DB | `src/knowledge/db.js` |
| Knowledge pipeline | `src/knowledge/updateCycle.js`, `discovered/promote.js` |
| Tools (function calling) | `src/tools/*` |
| Session memory | `src/memory/sessionMemory.js` |
| Visual orchestrator | `src/visual/visualOrchestrator.js`, `visualProtocol.js` |
| Visual catalog/intent | `src/visual/visualCatalog.js`, `visualIntentGate.js` |
| Avatar | `src/avatar/AvatarProvider.js`, `providers/` |
| KOS ingestion | `src/kos/sources/` |
| KOS extraction | `src/kos/extraction/` |
| KOS publication | `src/kos/publication/` |
| KOS DB schema | `src/kos/db/kosSchema.js` |
| Wine card | `src/wineCard/` |
| Frontend | `public/` |
| CI | `.github/workflows/startup-smoke.yml` |
| Smoke tests | `scripts/*smoke.js` |
| Unit tests | `tests/*.test.js` |
| Architectural docs | `docs/ARCHITECTURE.md`, `docs/KNOWLEDGE_PIPELINE_ARCHITECTURE.md` |

## Docs for agents

| File | Purpose |
|---|---|
| `PROJECT.md` (this file) | What the project is, key paths |
| `ARCHITECTURE.md` (this dir) | Components, state machines, contracts |
| `INVARIANTS.md` (this dir) | Safety, production, and architectural invariants |
| `CONTEXT_MAP.md` (this dir) | Progressive loading guide for task types |
| `DEFINITION_OF_DONE.md` (this dir) | Completion criteria and verification |
| `domains/realtime-voice.md` | Realtime session lifecycle, PTT, barge-in |
| `domains/provider-adapters.md` | Gemini, Grok, Mock adapter contracts |
| `domains/knowledge-retrieval.md` | Search, embeddings, KOS pipeline |
| `domains/visual-system.md` | Visual orchestrator, events, B-roll |
| `domains/database.md` | Schema, migrations, KOS tables |
| `domains/security.md` | Secrets, SSRF, deployment gates |
| `contracts/provider-adapter.md` | Provider adapter interface |
| `contracts/visual-event.md` | Visual event protocol |
| `contracts/knowledge-search.md` | Knowledge search contract |
