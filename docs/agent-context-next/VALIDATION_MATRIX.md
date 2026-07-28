# VALIDATION_MATRIX.md — Validation scenarios

Each scenario specifies: context to load, context to skip, real implementation paths to inspect, expected agent behavior, prohibited actions, verification method, and failure signals.

---

## Scenario 1: PTT audio frame dropped during active turn

**Context to load:**
- `domains/realtime-voice.md`
- `INVARIANTS.md` — turn lifecycle contracts

**Context to skip:**
- `domains/knowledge-retrieval.md`
- `domains/visual-system.md`

**Real implementation paths to inspect:**
- `src/realtime/realtimeServer.js` — `onBinary()`, `isActiveTurn()`, `inputEndedAt`
- `tests/pttFrameGuards.test.js`

**Expected agent behavior:**
- Audio frames after `inputEndedAt` are dropped with `reason=no_active_input`
- No crash, no hanging state
- Session remains inspectable

**Prohibited actions:**
- Modifying `isActiveTurn()` logic without regression test
- Switching to automatic VAD
- Adding `node -r` injection

**Verification method:**
- Run `tests/pttFrameGuards.test.js`
- Verify `inputEndedAt` is the only authoritative signal

**Failure signals:**
- Audio frames processed after `inputEndedAt`
- `isActiveTurn()` checks `generation.status` instead of `inputEndedAt`
- Session state becomes inconsistent

---

## Scenario 2: Knowledge search returns empty for unknown query

**Context to load:**
- `domains/knowledge-retrieval.md`
- `contracts/knowledge-search.md`

**Context to skip:**
- `domains/realtime-voice.md`
- `domains/visual-system.md`

**Real implementation paths to inspect:**
- `src/knowledge/search.js` — `search()`, `keywordSearch()`
- `src/tools/searchWineKnowledge.js` — `impl()`, `buildQueryVariants()`

**Expected agent behavior:**
- `search()` returns `{ hits: [], tookMs: ..., mode: 'keyword' }`
- `search_wine_knowledge` returns `{ found: false, status: 'not_found', results: [], instruction: ... }`
- Model does NOT answer from memory alone

**Prohibited actions:**
- Throwing on empty knowledge base
- Changing `search()` signature without updating all callers
- Removing `instruction` field from tool response

**Verification method:**
- Run `tests/knowledgeSearch.test.js`
- Verify empty hits returned, not thrown

**Failure signals:**
- `search()` throws on empty index
- `search_wine_knowledge` returns without `instruction` field
- Model answers from memory when tool returns `not_found`

---

## Scenario 3: Visual event emitted for stale generationId

**Context to load:**
- `domains/visual-system.md`
- `contracts/visual-event.md`

**Context to skip:**
- `domains/knowledge-retrieval.md`
- `domains/realtime-voice.md`

**Real implementation paths to inspect:**
- `src/visual/visualOrchestrator.js` — `isActive()`, `emitEvent()`
- `src/visual/visualProtocol.js` — `assertVisualEvent()`

**Expected agent behavior:**
- `isActive(generationId)` returns `false` for stale generation
- `emitEvent()` returns `false` (not sent)
- No visual state change

**Prohibited actions:**
- Emitting events without generationId check
- Removing `html` field prohibition
- Changing `VISUAL_EVENT_TYPES` without updating renderer

**Verification method:**
- Run `tests/visualOrchestrator.test.js`
- Verify stale generationId events are dropped

**Failure signals:**
- Visual events emitted for wrong generation
- `html` field allowed in events
- Renderer crashes on unknown event type

---

## Scenario 4: Provider interrupt during audio streaming

**Context to load:**
- `domains/realtime-voice.md`
- `domains/provider-adapters.md`

**Context to skip:**
- `domains/knowledge-retrieval.md`
- `domains/visual-system.md`

**Real implementation paths to inspect:**
- `src/realtime/realtimeServer.js` — interrupt handling, `session.interrupt`
- `src/realtime/geminiLiveProvider.js` — `interrupt()` method
- `src/realtime/grokVoiceProvider.js` — `interrupt()` method

**Expected agent behavior:**
- `response.cancelled` sent with reason `interruption` or `new_input`
- Provider session rotated (new Gemini/Grok session)
- Visual events: `visual.timeline.cancel` + `visual.reset` emitted
- Client stops playback immediately

**Prohibited actions:**
- Waiting for provider confirmation before stopping
- Leaving orphaned generation state
- Using same provider session for next turn

**Verification method:**
- Run `tests/geminiProviderInterrupt.test.js`
- Verify playback stops, new turn starts cleanly

**Failure signals:**
- Playback continues after interrupt
- Old generation events affect new turn
- Provider session reused after interrupt

---

## Scenario 5: Hybrid search falls back to keyword-only

**Context to load:**
- `domains/knowledge-retrieval.md`
- `contracts/knowledge-search.md`

**Context to skip:**
- `domains/realtime-voice.md`
- `domains/visual-system.md`

**Real implementation paths to inspect:**
- `src/knowledge/search.js` — `search()`, semantic branch try/catch
- `src/knowledge/searchMode.js` — `getMode()`

**Expected agent behavior:**
- `search()` returns `{ hits: ..., mode: 'keyword' }` (not `hybrid`)
- No error thrown
- Console error logged: `semantic branch failed, falling back to keyword-only`

**Prohibited actions:**
- Throwing on semantic search failure
- Returning empty hits when keyword search works
- Changing fallback behavior without test

**Verification method:**
- Run `tests/knowledgeSearch.test.js`
- Verify fallback returns keyword results

**Failure signals:**
- `search()` throws on semantic failure
- Empty results when keyword search has hits
- `mode: 'hybrid'` returned when semantic failed

---

## Scenario 6: KOS schema migration detects drift

**Context to load:**
- `domains/database.md`
- `INVARIANTS.md` — deployment gate

**Context to skip:**
- `domains/knowledge-retrieval.md`
- `domains/visual-system.md`

**Real implementation paths to inspect:**
- `src/kos/db/kosSchema.js` — `initKosSchema()`, `computeMigrationChecksum()`

**Expected agent behavior:**
- `KOS_SCHEMA_DRIFT_DETECTED` error thrown on checksum mismatch
- Transaction rolled back
- `schemaInitialized` set to `false`
- `schemaInitError` captured

**Prohibited actions:**
- Skipping drift detection
- Using `'dev'` checksum in production
- Continuing after schema error

**Verification method:**
- Verify checksum computation matches stored checksum
- Verify rollback on drift detection

**Failure signals:**
- Schema applied without checksum verification
- `schemaInitialized` true after drift
- Production uses `'dev'` checksum

---

## Scenario 7: SSRF protection blocks private IP

**Context to load:**
- `domains/security.md`
- `INVARIANTS.md` — safety boundaries

**Context to skip:**
- `domains/knowledge-retrieval.md`
- `domains/visual-system.md`

**Real implementation paths to inspect:**
- `src/kos/sources/ssrfProtection.js` — `validateUrlSsrf()`, `isPrivateIp()`

**Expected agent behavior:**
- `SsrfValidationError` thrown with code `KOS_SSRF_PRIVATE_IP`
- No fetch attempted
- All resolved IPs checked (not just first)

**Prohibited actions:**
- Bypassing SSRF check for "trusted" URLs
- Checking only first resolved IP
- Allowing test-mode bypasses in production

**Verification method:**
- Run `tests/ssrfProtection.test.js`
- Verify private IP blocked

**Failure signals:**
- Private IP URL accepted
- Only first IP checked
- Test bypass active in production

---

## Scenario 8: Visual intent gate rejects low-confidence wine

**Context to load:**
- `domains/visual-system.md`
- `contracts/visual-event.md`

**Context to skip:**
- `domains/knowledge-retrieval.md`
- `domains/realtime-voice.md`

**Real implementation paths to inspect:**
- `src/visual/visualIntentGate.js` — `decideVisualIntent()`, `hasPublishedWine()`

**Expected agent behavior:**
- `decision: 'avatar_only'` for confidence < 0.75
- `decision: 'clear_visual'` if activeWineId exists
- No wine card shown

**Prohibited actions:**
- Lowering `MIN_CONFIDENCE` without justification
- Showing wine card without published status
- Bypassing trust source validation

**Verification method:**
- Run `tests/visualIntentGate.test.js`
- Verify low confidence rejected

**Failure signals:**
- Wine card shown for low-confidence intent
- `MIN_CONFIDENCE` changed without test update
- Untrusted evidence source accepted

---

## Scenario 9: Provider rotation on Gemini per-turn mode

**Context to load:**
- `domains/provider-adapters.md`
- `contracts/provider-adapter.md`

**Context to skip:**
- `domains/knowledge-retrieval.md`
- `domains/visual-system.md`

**Real implementation paths to inspect:**
- `src/realtime/geminiLiveProvider.js` — rotation mode, session creation
- `src/realtime/providerRegistry.js` — `createSession()`

**Expected agent behavior:**
- New Gemini session created per turn (rotationMode: per_turn)
- Previous session closed/destroyed
- Voice preserved across rotations within session

**Prohibited actions:**
- Reusing provider session across turns
- Losing voice configuration on rotation
- Creating session without API key

**Verification method:**
- Run `tests/dashboardVoiceConfiguration.test.js`
- Verify new session per turn

**Failure signals:**
- Same session reused across turns
- Voice reset on rotation
- Session created without required config

---

## Scenario 10: Bounded query variant generation

**Context to load:**
- `domains/knowledge-retrieval.md`
- `contracts/knowledge-search.md`

**Context to skip:**
- `domains/realtime-voice.md`
- `domains/visual-system.md`

**Real implementation paths to inspect:**
- `src/tools/searchWineKnowledge.js` — `buildQueryVariants()`, `runBoundedRetrieval()`

**Expected agent behavior:**
- Max 5 variants generated
- First variant with hits wins (bounded, not exhaustive)
- Spelled-out ↔ numeral forms handled ("семь тысяч" ↔ "7000")

**Prohibited actions:**
- Unbounded variant generation
- Exhaustive search across all variants
- Changing variant logic without regression test

**Verification method:**
- Run `tests/searchWineKnowledgeFallback.test.js`
- Verify max 5 variants, first-hit wins

**Failure signals:**
- More than 5 variants generated
- All variants searched exhaustively
- Numeral forms not handled

---

## Scenario 11: Production deployment gate checks

**Context to load:**
- `INVARIANTS.md` — deployment gate
- `DEFINITION_OF_DONE.md`

**Context to skip:**
- Domain files (not needed for gate checks)

**Real implementation paths to inspect:**
- `npm run check:missing-imports` script
- `tests/startupNoAdminAuth.test.js`
- `npm run test:smoke` scripts
- `.github/workflows/startup-smoke.yml`

**Expected agent behavior:**
- All 4 gates pass before merge/deploy
- `check:missing-imports` finds no untracked files
- Startup test passes without admin auth module
- Smoke tests pass against freshly started server
- CI workflow green

**Prohibited actions:**
- Skipping any gate
- Disabling CI checks
- Merging with failing gates

**Verification method:**
- Run all 4 gates manually
- Verify CI workflow passes

**Failure signals:**
- Missing imports detected
- Startup test fails
- Smoke tests fail
- CI red

---

## Scenario 12: Multilingual detection does not flap on proper nouns

**Context to load:**
- `ARCHITECTURE.md` — multilingual behavior
- `INVARIANTS.md` — personality and factuality

**Context to skip:**
- Domain files (not needed for language detection)

**Real implementation paths to inspect:**
- `src/realtime/realtimePrompt.js` — language detection logic
- `src/persona/wineExpertPersona.js` — multilingual prompt

**Expected agent behavior:**
- Reply in language of last clearly understood utterance
- Do not flap on single foreign word or name
- Proper nouns (Fetească Neagră, Crama, Purcari) not treated as language-switch signals

**Prohibited actions:**
- Switching language on proper noun detection
- Ignoring user's language preference
- Flapping between languages

**Verification method:**
- Test with mixed-language input containing proper nouns
- Verify stable language detection

**Failure signals:**
- Language switches on proper noun
- Response in wrong language
- Flapping between languages

---

## Scenario 13: Session memory persisted across turns

**Context to load:**
- `ARCHITECTURE.md` — tools (function calling)
- `contracts/knowledge-search.md`

**Context to skip:**
- `domains/visual-system.md`

**Real implementation paths to inspect:**
- `src/tools/updateSessionMemory.js` — session memory tool
- `src/memory/sessionMemory.js` — session memory storage
- `src/realtime/realtimePrompt.js` — memory injection into prompt

**Expected agent behavior:**
- `update_session_memory` tool updates session memory
- Memory persists across turns within session
- Memory injected into prompt as `[CURRENT CONTEXT]`

**Prohibited actions:**
- Persisting memory across sessions
- Storing secrets in session memory
- Memory injection without sanitization

**Verification method:**
- Run tests that verify session memory persistence
- Verify memory not leaked across sessions

**Failure signals:**
- Memory lost between turns
- Memory leaked across sessions
- Memory contains unsanitized content

---

## Scenario 14: KOS crawled content invisible to answers

**Context to load:**
- `domains/knowledge-retrieval.md`
- `domains/database.md`

**Context to skip:**
- `domains/visual-system.md`
- `domains/realtime-voice.md`

**Real implementation paths to inspect:**
- `src/kos/sources/` — website crawling
- `src/kos/extraction/` — document → candidate facts
- `src/kos/publication/` — fact publication
- `src/knowledge/search.js` — `search()` only reads from `knowledge/index/index.json`

**Expected agent behavior:**
- Crawled content written to `kos_source_documents`
- Extraction → validation → publication stages NOT wired
- `search()` returns empty for crawled-only content
- This is a known gap, not a bug

**Prohibited actions:**
- Assuming crawled content is searchable
- Wiring extraction without full pipeline test
- Changing `search()` contract to include KOS

**Verification method:**
- Verify `search()` only reads from `index.json`
- Verify crawled content in `kos_source_documents` but not in search results

**Failure signals:**
- `search()` returns KOS content (pipeline incomplete)
- Extraction wired without publication
- Assumptions about KOS availability treated as facts
