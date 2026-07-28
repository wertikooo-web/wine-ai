# CONTEXT_MAP.md — Progressive loading guide

For each task type, this map specifies: which context files to load, which to skip, and which real code files to investigate.

---

## 1. UI change (dashboard, CSS, frontend)

**Load:**
- `PROJECT.md` — key paths (`public/`)
- `INVARIANTS.md` — safety boundaries

**Skip:** `domains/provider-adapters.md`, `domains/knowledge-retrieval.md`

**Find real code:**
- `public/dashboard.html`, `public/*.mjs`
- `public/visual/VisualStoryController.mjs`
- `src/server.js` (API routes serving frontend)

**Verify:** Browser renders correctly. `/health` returns 200.

---

## 2. WebSocket lifecycle bug

**Load:**
- `ARCHITECTURE.md` — session/turn state machine
- `domains/realtime-voice.md` — lifecycle details
- `INVARIANTS.md` — turn lifecycle contracts

**Skip:** `domains/knowledge-retrieval.md`, `domains/visual-system.md`

**Find real code:**
- `src/realtime/realtimeServer.js` — state machine implementation
- `src/realtime/wsProtocol.js` — framing, sendJson, sendBinary
- `tests/realtimeLifecycle.test.js`

**Verify:** All lifecycle transitions complete. No hanging generations.

---

## 3. Interruption / barge-in bug

**Load:**
- `ARCHITECTURE.md` — INTERRUPTING state
- `domains/realtime-voice.md` — barge-in flow
- `domains/provider-adapters.md` — provider-specific interrupt handling

**Find real code:**
- `src/realtime/realtimeServer.js` — interrupt handling, `session.interrupt`
- `src/realtime/geminiLiveProvider.js` — `interrupt()` method
- `src/realtime/grokVoiceProvider.js` — `interrupt()` method
- `tests/geminiProviderInterrupt.test.js`

**Verify:** Playback stops immediately. New turn starts cleanly. Old generation events are dropped.

---

## 4. Provider-specific bug (Gemini)

**Load:**
- `domains/provider-adapters.md`
- `contracts/provider-adapter.md`

**Find real code:**
- `src/realtime/geminiLiveProvider.js`
- `tests/grokProvider.test.js` (for comparison patterns)

---

## 5. Provider-specific bug (Grok)

**Load:** Same as Gemini.

**Find real code:**
- `src/realtime/grokVoiceProvider.js`
- `src/grokVoices.js`
- `tests/grokProvider.test.js`, `tests/grokCancellationRace.test.js`

---

## 6. KOS factuality issue

**Load:**
- `domains/knowledge-retrieval.md` — pipeline state
- `INVARIANTS.md` — knowledge retrieval contracts

**Find real code:**
- `src/kos/extraction/`, `src/kos/publication/`, `src/kos/validation/`
- `src/knowledge/search.js`
- `src/tools/searchWineKnowledge.js`
- `docs/KNOWLEDGE_RUNTIME_AUDIT.md` — known pipeline gaps

**Verify:** The KOS → retrieval pipeline is currently incomplete (see audit §4). Website-crawled content is invisible to answers.

---

## 7. Embeddings / retrieval issue

**Load:**
- `domains/knowledge-retrieval.md`
- `contracts/knowledge-search.md`

**Find real code:**
- `src/knowledge/search.js` — keyword + semantic + RRF
- `src/knowledge/searchMode.js` — runtime toggle
- `src/knowledge/embeddings.js` — Gemini embeddings
- `src/knowledge/db.js` — pgvector queries
- `scripts/knowledge-embed-backfill.js`

**Verify:** `search()` returns results. Hybrid mode produces fused ranks.

---

## 8. Database migration

**Load:**
- `domains/database.md`
- `INVARIANTS.md` — deployment gate

**Find real code:**
- `src/kos/db/kosSchema.js` — schema creation
- `src/knowledge/db.js` — knowledge tables
- `src/knowledge/searchMode.js` — `app_settings` table
- `scripts/knowledge-embed-backfill.js` — embedding backfill

**Verify:** Schema matches code. No checksum drift.

---

## 9. Visual event change

**Load:**
- `domains/visual-system.md`
- `contracts/visual-event.md`
- `INVARIANTS.md` — visual event protocol contracts

**Find real code:**
- `src/visual/visualProtocol.js` — event types, validation
- `src/visual/visualOrchestrator.js` — event emission
- `src/visual/visualIntentGate.js` — intent detection
- `src/visual/visualCatalog.js` — catalog
- `public/visual/VisualStoryController.mjs` — DOM renderer
- `tests/visualOrchestrator.test.js`, `visualProtocol.test.js`, `visualRealtime.test.js`

**Verify:** Events flow from orchestrator to renderer. Stale generationId events are dropped.

---

## 10. Production debugging

**Load:**
- `PROJECT.md` — key paths
- `INVARIANTS.md` — deployment gate, safety boundaries
- `DEFINITION_OF_DONE.md`

**Find real code:**
- `src/server.js` — entry point, routes
- `scripts/http-smoke.js`, `scripts/realtime-smoke.js`
- `docs/incidents/2026-07-26-missing-admin-auth-module.md`

**Verify:** `/health` returns 200. Smoke tests pass. No crash loops.

---

## 11. Release verification

**Load:**
- `DEFINITION_OF_DONE.md`
- `INVARIANTS.md` — deployment gate

**Verify:** All 4 deployment gates pass. CI green. Final diff reviewed.

---

## 12. Security-sensitive change

**Load:**
- `INVARIANTS.md` — safety boundaries
- `domains/security.md`

**Find real code:**
- `src/kos/sources/ssrfProtection.js` — SSRF protection
- `src/kos/sources/robotsPolicy.js` — robots compliance
- `src/server.js` — auth, route guards

**Verify:** No secrets exposed. No unauthorized mutations.
