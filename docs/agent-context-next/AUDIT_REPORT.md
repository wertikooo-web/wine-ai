# AUDIT_REPORT.md — Agent context audit findings

## Summary

This audit covers all agent instructions in the repository: `AGENTS.md`, `~/.claude/CLAUDE.md`, `.claude/skills/winemd-rive/SKILL.md`, existing documentation (`docs/ARCHITECTURE.md`, `docs/KNOWLEDGE_RUNTIME_AUDIT.md`, `docs/KNOWLEDGE_PIPELINE_ARCHITECTURE.md`, `docs/PROJECT_STATUS.md`), and the new `docs/agent-context-next/` structure.

## Key findings

### Conflicts between AGENTS.md and actual code

1. **AGENTS.md says "no embeddings" but code has embeddings + pgvector + hybrid search**
   - Verified from code: `src/knowledge/embeddings.js`, `src/knowledge/db.js` (knowledge_chunk_embeddings table), `src/knowledge/search.js` (semantic branch)
   - Verified from tests: `tests/knowledgeSearch.test.js` tests hybrid search
   - AGENTS.md is outdated on this point

2. **AGENTS.md says "no OpenAI" but README says it exists**
   - Verified from configuration: `.env.example` has `GEMINI_API_KEY`, `GROK_API_KEY`, no OpenAI
   - Documentation-only claim in README (not verified from code)

3. **AGENTS.md omits Grok Voice (fully implemented)**
   - Verified from code: `src/realtime/grokVoiceProvider.js`, `src/grokVoices.js`
   - Verified from tests: `tests/grokProvider.test.js`, `tests/grokCancellationRace.test.js`
   - AGENTS.md architecture diagram only shows "Gemini Live / mock"

4. **ARCHITECTURE.md says "keyword/term-overlap only" — outdated**
   - Verified from code: `src/knowledge/search.js` has semantic branch with RRF
   - Verified from tests: `tests/knowledgeSearch.test.js` tests hybrid mode
   - `docs/ARCHITECTURE.md` is partially outdated

### Verified facts

#### From code (read and inspected)

- **PTT race fix**: `isActiveTurn()` in `onBinary()` checks `currentGeneration && inputStartedAt && !inputEndedAt` — no status checks (commit `a227d17`)
- **Search pipeline**: keyword (IDF) + optional semantic (pgvector + Gemini embeddings) via RRF
- **Visual event protocol**: `visualProtocol.js` validates events, forbids `html` field
- **Visual orchestrator**: generation-scoped events, phase scheduling, timer management
- **KOS schema**: 4-version migration system with checksum tracking
- **SSRF protection**: DNS resolution, IP validation, alternative notation blocking
- **Provider adapters**: Gemini (`per_turn`), Grok (`errors_only`), Mock (`errors_only`)

#### From tests (glob'd and verified exist)

- `tests/pttFrameGuards.test.js` — PTT frame guard tests
- `tests/knowledgeSearch.test.js` — keyword/hybrid search tests
- `tests/searchWineKnowledgeFallback.test.js` — bounded retrieval tests
- `tests/visualOrchestrator.test.js` — orchestrator lifecycle tests
- `tests/visualProtocol.test.js` — event validation tests
- `tests/visualIntentGate.test.js` — intent gating tests
- `tests/grokProvider.test.js` — Grok adapter tests
- `tests/geminiProviderInterrupt.test.js` — Gemini interrupt tests

#### From configuration

- `.env.example` documents all environment variables
- No Antigravity or Codex configuration files found in repository
- No `.opencode` directory found
- `.claude/skills/winemd-rive/SKILL.md` exists (111 lines)

#### Documentation-only claims

- **README.md claims OpenAI integration** — not verified from code
- **`docs/PROJECT_STATUS.md`** — status claims not independently verified
- **`docs/KNOWLEDGE_PIPELINE_ARCHITECTURE.md`** — pipeline design not fully verified against code

### Assumptions

1. **Antigravity format unknown**: No Antigravity configuration files found in repository. Migration proposal is speculative.
2. **Codex format unknown**: No Codex configuration files found in repository. `AGENTS.next.md` is a proposal, not verified format.
3. **KOS pipeline gap confirmed**: Extraction → validation → publication stages not wired into scheduled jobs (verified from code inspection and `docs/KNOWLEDGE_RUNTIME_AUDIT.md`).
4. **Demo wines hardcoded**: `visualCatalog.js` has 3 demo wines, not from knowledge base (verified from code).

### Unresolved areas

1. **Antigravity context-loading format**: Must be verified from official documentation before implementation.
2. **Codex context-loading format**: Must be verified from official documentation before implementation.
3. **KOS pipeline completion**: Extraction → publication stages exist in code but are not wired. This is a known gap, not a bug.
4. **Rive character renderer**: Planned but not built. `.claude/skills/winemd-rive/SKILL.md` exists but no `.riv` file in repository.
5. **14 pre-existing test failures**: KOS/avatar tests — do NOT run full `npm test`. These failures are pre-existing, not caused by this work.

## Migration map

### Current → New

| Current | New | Notes |
|---|---|---|
| `AGENTS.md` (146 lines) | `AGENTS.next.md` | Updated with context loading, domain files, contracts |
| `~/.claude/CLAUDE.md` (11 lines) | `CLAUDE.next.md` | Added project context, domain loading, hard rules |
| `docs/ARCHITECTURE.md` (94 lines) | `ARCHITECTURE.md` | Updated with state machine, provider contract, visual system |
| (none) | `PROJECT.md` | New: what the project is, key paths |
| (none) | `INVARIANTS.md` | New: non-negotiable rules with classification |
| (none) | `CONTEXT_MAP.md` | New: progressive loading guide |
| (none) | `DEFINITION_OF_DONE.md` | New: completion criteria |
| (none) | `domains/*.md` | New: 6 domain-specific files |
| (none) | `contracts/*.md` | New: 3 interface contract files |
| (none) | `VALIDATION_MATRIX.md` | New: 14 validation scenarios |
| (none) | `AUDIT_REPORT.md` | New: this file |

### Not changed

- Production code (`src/`)
- Active `CLAUDE.md` / `AGENTS.md`
- Database schema
- Dependencies
- Env files
- Deployment configuration
- Tests

## Verdict

**READY_FOR_CODEX_REVIEW** — all 19 files written, all constraints satisfied:
- No production code modified
- No active instructions modified
- No database schema changed
- No dependencies added
- No env files changed
- No deployment config changed
- All files based on verified code/tests/config
- Assumptions clearly marked
- Unresolved areas documented
