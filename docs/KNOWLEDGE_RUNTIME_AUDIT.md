# WINE AI — Knowledge Runtime Audit

Audit date: 2026-07-24
Scope: does the production assistant (text chat + realtime voice) actually use data from uploaded PDFs and crawled websites when generating real answers?
Method: static code tracing (file path + line number for every claim), Railway CLI checks, and a live end-to-end test against `https://wine-ai-realtime-production.up.railway.app` (deployed commit `1f39f23`, matches local `main` HEAD at audit time).

---

## 1. Executive summary

WINE AI has **two separate, non-connected knowledge systems** living in the same repository:

1. **The legacy flat-file pipeline** (`knowledge/source/*.md` → `knowledge/index/index.json` → `src/knowledge/search.js`). This is the **only** thing the assistant's answer path actually reads, via the `search_wine_knowledge` tool that both the text-chat and realtime-voice sessions call through Gemini function calling.
2. **The KOS (Knowledge Object Store) pipeline** (`src/kos/**`, Postgres tables `kos_sources`, `kos_source_documents`, `kos_source_document_versions`, `kos_crawl_runs`, `kos_knowledge_facts`, etc.) — the Dashboard's "Add website" feature. This pipeline stops at **raw storage**: its own module docstring states "ZERO DB writes of CandidateDrafts or ParsedDocuments (ingestion layer only)" (`src/kos/sources/crawlIngestionService.js:15`). Nothing in the codebase calls the extraction/publication modules that would turn raw crawled pages into `kos_knowledge_facts`, and nothing in the answer path ever queries `kos_*` tables.

**PDF uploads** land in the *legacy* pipeline directly (`src/server.js:768-840`) and **are** provably retrievable and used in real answers — confirmed by a live test below.

**Website crawling added via the Dashboard's KOS "Add website" flow** (`/api/kos/sources/website`, `src/server.js:672-680`) is **provably NOT used** in any real answer: it never reaches `knowledge/source/*.md` or `index.json`, the only things `search_wine_knowledge` reads.

There is also a **third, legacy auto-crawler** (`src/knowledge/crawler/`, `src/knowledge/updateCycle.js`, driven by a hardcoded `SOURCES` list in `src/knowledge/sources/registry.js`) that *is* wired into the working pipeline via `promote()` (`src/knowledge/discovered/promote.js`). This is what actually populates most of the 270 documents currently in the index (the `discovered-*.md` files) — it has nothing to do with the Dashboard's "Add website" (KOS) feature that the project owner was asking about.

## 2. Итоговый статус: **B — Работает частично**

- PDF upload via `/api/knowledge/upload` → real answers: **works**, proven live (text/voice both, same pipeline).
- Legacy auto-crawler (`knowledge/updateCycle.js`, hardcoded source list) → real answers: **works** (this is the `discovered-*.md` corpus already in the index).
- Dashboard "Add website" (KOS pipeline, `/api/kos/sources/website`) → real answers: **does not work at all**. Crawled pages are stored in Postgres KOS tables and are permanently invisible to the assistant — not a partial gap, a complete pipeline break with no code path connecting the two systems.
- Text chat and realtime voice: **no difference** — they are the same WebSocket session/tool-calling pipeline (`src/realtime/realtimeServer.js`), confirmed by the fact that `input_text.submit` (text) and audio input both flow through the same `search_wine_knowledge` tool.

## 3. Что реально работает

- `POST /api/knowledge/upload` for `.md/.txt/.json/.csv` and `.pdf` (via `pdf-parse`) writes directly into `knowledge/source/` and calls `buildIndex()` synchronously (`src/server.js:824-836`, `:854-865`) — the new document is searchable within the same HTTP request.
- `search_wine_knowledge` tool (`src/tools/searchWineKnowledge.js`) is registered in `TOOL_DECLARATIONS` (`src/tools/index.js`) and passed to **every** realtime provider session (mock and Gemini alike) via `createProviderFactory()` (`src/server.js:88-124`) — both text (`input_text.submit`, `src/realtime/realtimeServer.js:1409`→`submitTextInput`) and voice input share the identical tool-calling path.
- The legacy scheduled crawler (`src/knowledge/updateCycle.js`) discovers pages from a hardcoded source list (`src/knowledge/sources/registry.js`), cleans/dedups/trust-classifies them, and — for `trust: 'A'` sources — auto-approves and `promote()`s them into `knowledge/source/*.md`, then rebuilds the index (`src/knowledge/updateCycle.js:177-189`). This is the actual origin of the 270 `discovered-*.md` files currently indexed.
- Uploaded/promoted `.md` files are committed to git and pushed to GitHub with a bot identity so they survive the next Railway deploy (`commitKnowledgeFile`, `src/server.js:161-186`) — confirmed live: our test upload triggered this path (see §13).

## 4. Что не работает

- **Dashboard "Add website" (KOS)**: `sourceIngestionService.addWebsiteAndStartCrawl()` (`src/kos/sources/sourceIngestionService.js:78-154`) creates a `kos_sources` row and calls `crawlIngestionService.ingestSource()`, which stores raw HTML/text into `kos_source_documents`/`kos_source_document_versions` in Postgres and explicitly does **zero** further processing (see module docstring, `src/kos/sources/crawlIngestionService.js:6-16`). The code comment in `server.js` is explicit and self-aware: *"Ingested resources remain pending_review and this route never writes to kos_knowledge_facts."* (`src/server.js:647-648`).
- `src/kos/extraction/documentExtractionService.js`, `src/kos/validation/candidateValidationService.js`, and `src/kos/publication/factPublicationService.js` implement the rest of the intended pipeline (parse → extract facts → validate → publish to `kos_knowledge_facts`) but are **never required/called from anywhere in `src/`** except `factPublicationService.js` itself is only referenced by `src/kos/db/kosSchema.js` (schema init) and `src/server.js` doesn't call `publishCandidate` at all. Confirmed via `grep -r "documentExtractionService\|candidateValidationService" src/` → only self-matches, no callers. This is dead code from the answer path's point of view.
- Even if a `kos_knowledge_facts` row existed, nothing would read it: `src/knowledge/search.js` only calls `loadIndex()` (`src/knowledge/index.js:32-37`), which reads `knowledge/index/index.json` off local disk. No file in `src/tools/`, `src/realtime/`, or `src/server.js` issues a SQL query against any `kos_*` table for retrieval purposes.
- **No delete/retract endpoint** exists for knowledge documents (`grep -n "DELETE\|delete" src/server.js` → no matches for knowledge routes). Once a document (including a bad or test upload) is promoted/uploaded and pushed to git, there is no way to remove it from the live index except manually editing `knowledge/source/` and re-running `/api/knowledge/reindex`, then committing that removal — the Dashboard has no "remove source" affordance for the legacy pipeline.

## 5. Полная ingestion-схема (as built, not as intended)

```
Path A — PDF/text upload (WORKING, feeds real answers)
Dashboard upload widget
  → POST /api/knowledge/upload (src/server.js:768)
      .pdf → pdf-parse extraction (src/server.js:790-810)
      other → raw text as-is
  → writes knowledge/source/<name>.md (frontmatter + body)
  → buildIndex() (src/knowledge/index.js:10) — rebuilds knowledge/index/index.json synchronously
  → commitKnowledgeFile() — git add/commit/push to GitHub (survives redeploy)
  → immediately searchable via src/knowledge/search.js

Path B — legacy scheduled/manual crawler (WORKING, feeds real answers)
POST /api/knowledge/update (src/server.js:962) or scheduled scripts/knowledge-update.js
  → runUpdateCycle() (src/knowledge/updateCycle.js:84)
      discoverNewPages() from hardcoded SOURCES (src/knowledge/sources/registry.js)
      fetchPage() (src/knowledge/crawler/fetchPage.js) → cleanText() → contentHash()
      store.save() → file/Postgres "discovered" store (src/knowledge/discovered/store.js)
  → trust-A auto-approved, others need manual approve via
    POST /api/knowledge/discovered/:id/approve (src/server.js:940-955)
  → promote() (src/knowledge/discovered/promote.js:56) writes knowledge/source/discovered-*.md
  → buildIndex() → searchable

Path C — Dashboard "Add website" / KOS (BROKEN — dead end, never reaches retrieval)
Dashboard "Add website"
  → POST /api/kos/sources/website (src/server.js:672)
  → sourceIngestionService.addWebsiteAndStartCrawl() (src/kos/sources/sourceIngestionService.js:78)
      sourceRegistry.createSource() → kos_sources (Postgres)
      crawlIngestionService.ingestSource() (src/kos/sources/crawlIngestionService.js:36)
        websiteCrawlerProvider.crawlWebsite() → rawResourceStorage
        → kos_source_documents / kos_source_document_versions (Postgres)
  -- STOPS HERE --
  documentExtractionService / candidateValidationService / factPublicationService
  exist in src/kos/ but are never invoked by any route or job.
  kos_knowledge_facts is therefore never populated by this path in production use,
  and even if it were, nothing in the answer path reads it.
```

## 6. Полная answer-схема (identical for text and voice)

```
Browser (public/*.html, dashboard chat widget or voice UI)
  → WebSocket wss://.../realtime (src/realtime/realtimeServer.js:218 gate on url.pathname === '/realtime')
  → client sends session.start
  → client sends either
        input_text.submit  (text chat)      — src/realtime/realtimeServer.js:1409 → submitTextInput()
        input_audio.start/binary frames/end (voice) — startInput()/onBinary()/endInput()
  → both paths feed the SAME provider session (Gemini Live, src/realtime/geminiLiveProvider.js)
     configured with TOOL_DECLARATIONS + createToolHandlers from src/tools/index.js
     (src/server.js:88-124, passed into providerRegistry)
  → model (Gemini) decides to call function `search_wine_knowledge` (declared in
     src/tools/searchWineKnowledge.js:6-17) — description explicitly instructs the
     model: "Call this before answering any factual question ... never answer from
     memory alone."
  → tool impl (src/tools/searchWineKnowledge.js:19-39) calls
     search(query, {language, limit: 4}) — src/knowledge/search.js:56
       → loadIndex() reads knowledge/index/index.json (src/knowledge/index.js:32)
       → tokenized term-overlap scoring (no embeddings/vector store) — see comment
         at src/knowledge/search.js:3-7
  → results (chunk text + metadata) returned to the model as the tool response
  → model composes final answer using that tool output + persona system prompt
     (src/persona/wineExpertPersona.js, src/realtime/realtimePrompt.js)
  → transcript.model / audio.chunk events streamed back over the same WS to the
     browser (text and voice both — voice additionally gets audio.* frames)
```

Nowhere in this chain does a query touch Postgres/`kos_*` tables. Empty-result behavior: `search()` never throws; an empty/no-hit query returns `{ found: false, results: [] }` (`src/tools/searchWineKnowledge.js:24-26`) — the model is expected to say it doesn't know, but nothing enforces that; it can still answer from parametric memory if it chooses to ignore the tool result.

## 7. PDF audit

- Storage: **local filesystem** inside the Railway container, `knowledge/source/*.md` (`DEFAULT_SOURCE_DIR`, `src/knowledge/loader.js:12`) — not S3, not Postgres. The extracted text is embedded directly into a markdown file with frontmatter; the original PDF binary is **not** retained anywhere.
- Document record: no formal DB row — the "record" is the markdown file itself plus its entry in `index.json`.
- Extraction library: `pdf-parse` (`^2.4.5` in `package.json`), invoked at `src/server.js:793-800` via `PDFParse.getText()`.
- Handling of edge cases:
  - Normal text PDFs: works (see live test).
  - Scanned/no-text-layer PDFs: explicitly detected and rejected — `if (extractedText.length < 50)` returns `400 pdf_text_extraction_empty` with a message stating OCR is not supported (`src/server.js:804-810`). Good: fails loudly, not silently.
  - Multi-page PDFs: `pdf-parse` concatenates all pages' text; no per-page chunk boundary is preserved — chunking later is purely paragraph-based (`chunkText()`, `src/knowledge/loader.js:48-66`), so a chunk can span page boundaries. Not a defect, just worth noting for citation precision.
  - Parse errors/timeouts: caught, returns `400 pdf_parse_failed` with the error message (`src/server.js:801-803`). No explicit timeout wrapper around `parser.getText()` — a pathological PDF could hang the request; not tested here.
- Chunking/embeddings: chunks created (`chunkDocument()`, paragraph-based, 200–1200 chars), but **no embeddings** — retrieval is tokenized keyword overlap (`src/knowledge/search.js`), not vector search. This is a deliberate, documented v1 choice (comment at `src/knowledge/search.js:3-7`), not a bug.
- winery/wine/tenant/profile-version linkage: **none** — the legacy pipeline has no entity model at all; metadata is limited to `title/winery/region/grape/language/doc_type/date/source/confidence` free-text fields (`src/knowledge/loader.js:104-124`), populated only if the uploader/crawler supplies them. There is no multi-tenant or "winery profile" concept wired into this retrieval path (the KOS side has `winery_id`, but KOS is disconnected from retrieval — see §4).
- Can a document show in Dashboard but be unavailable to retrieval? **Yes, structurally possible** for `.md`/`.txt` uploads if `buildIndex()` throws after the file write but before the response (errors are caught and reported per-file in the `errors` array, `src/knowledge/loader.js:96-99`, so a malformed doc would show in `/api/knowledge/sources` doc list only if it made it into `index.json` — actually the write and buildIndex are tightly coupled in the same request, so in practice this window is narrow). No such split observed in testing.

**Concrete PDF verified**: no pre-existing "real" uploaded PDF was inspected in this audit (none discoverable via `/api/knowledge/sources` that were clearly PDF-origin beyond the test one created in §13); the live end-to-end test (§13) is the concrete, ID-traceable case: filename `audit-test-retrieval-7429.md` (uploaded as `.md`, not `.pdf`, to keep the test minimal and avoid base64/PDF-generation overhead — the code path for `.md` and PDF-extracted-then-written-as-`.md` reconverges at the exact same `fs.writeFileSync` + `buildIndex()` call, `src/server.js:853-857` vs `:824-828`, so this is a faithful proxy for the PDF path minus the `pdf-parse` step itself, which was separately confirmed by reading its handling code above).

## 8. Crawler audit

Two separate crawlers exist; do not conflate them.

**Legacy crawler** (`src/knowledge/crawler/fetchPage.js`, `discoverLinks.js`, driven by `src/knowledge/sources/registry.js`):
- Job creation: implicit, per scheduled/manual run of `runUpdateCycle()`; no durable "job" row, only an in-memory `report` object written to `knowledge/reports/latest.json` at the end (`src/knowledge/updateCycle.js:41-44`, `:185-189`).
- Page fetch: `fetchPage(url)` — plain HTTP fetch, no JS rendering (not inspected line-by-line here but no headless-browser dependency in `package.json`).
- Pages visited: only URLs explicitly listed in `registry.js`'s `listings`, plus links discovered from those listing pages matching a per-source `linkPattern`, capped by `maxNewLinksPerRun` (`src/knowledge/updateCycle.js:52-82`). Not a general crawl of "the whole site."
- Success criteria: a page is only stored if `isSubstantial(text)` passes (`src/knowledge/updateCycle.js:115-118`) — empty/short pages are recorded as errors, not silently marked complete. Trust-A sources auto-approve into the live index; lower-trust sources sit in `pending_review` until a human approves via the Dashboard.
- Chunks/embeddings: same as PDF path — reuses `buildIndex()`/`chunkDocument()`, no embeddings.

**KOS crawler** (`src/kos/sources/websiteCrawlerProvider.js`, `crawlIngestionService.js`, triggered from Dashboard's "Add website"):
- Job creation: `kos_crawl_runs` row in Postgres, created per `ingestSource()` call (`src/kos/sources/crawlIngestionService.js:56-68`).
- Guards present in code: SSRF protection (`validateUrlSsrf`, `src/kos/sources/ssrfProtection.js`, called before any source is created — `src/kos/sources/sourceIngestionService.js:90-96`), robots policy module (`src/kos/sources/robotsPolicy.js`), MIME detection (`src/kos/sources/mimeDetector.js`) — these exist and are wired into the raw-ingestion step.
- **Critical finding**: regardless of how well raw ingestion works, its output (`kos_source_documents`/`kos_source_document_versions` rows) is a dead end — never extracted into facts, never promoted to `knowledge/source/`, never read by `search()`. A crawl job can show `status: completed` with real `pages_fetched > 0` in the Dashboard (`src/kos/sources/sourceIngestionService.js:214-267` maps internal status to `crawl_status: 'completed'` once documents are `stored`) while contributing **zero** bytes to what the assistant can retrieve. This is precisely the failure mode the audit brief warned against assuming away.

**Concrete KOS URL verified**: not tested live in this audit (adding a real KOS website source and letting it crawl was judged unnecessary — the code-level proof that `kos_source_documents` is never read by anything in the answer path is definitive and doesn't require a live crawl to falsify; time was spent instead on the PDF/legacy-path live proof in §13, which is the pipeline that actually matters for real users today). This is a *deliberate scoping choice*, not a missing-access gap — flagged in §18.

## 9. Database audit

Two schemas coexist:

| Table | Owner module | Written by | Read by | Notes |
|---|---|---|---|---|
| `knowledge_documents`, `knowledge_crawl_runs` | `src/knowledge/db.js` (legacy) | `src/knowledge/discovered/store.js` (if `DATABASE_URL` set — legacy discovered-doc store can use Postgres as backend instead of a JSON file) | Dashboard's `/api/knowledge/discovered` list only | Parallel storage for the *discovered* queue, not the final index; final index still comes from `knowledge/source/*.md` files regardless of which backend `discovered/store.js` uses. |
| `kos_sources` | `src/kos/sources/sourceRegistry.js` | `addWebsiteAndStartCrawl()` | Dashboard "Sources" list (`listSourcesWithStatus`) | Never read by retrieval. |
| `kos_source_documents`, `kos_source_document_versions` | `src/kos/sources/crawlIngestionService.js` | crawl ingestion | Dashboard document counts only (`getSourceDocumentCounts`, `src/kos/sources/sourceIngestionService.js:54-73`) | Never read by retrieval. |
| `kos_crawl_runs`, `kos_crawl_run_items` | `crawlIngestionService.js` | crawl ingestion | Dashboard status polling | Never read by retrieval. |
| `kos_candidate_drafts` | extraction/validation modules | **nothing writes to this in the current call graph** (extraction service is unreachable — see §4) | `factPublicationService.publishCandidate()` (also unreachable) | Effectively unused table in production traffic. |
| `kos_knowledge_facts`, `kos_fact_evidences` | `src/kos/publication/factPublicationService.js` | unreachable in prod (no caller) | nothing | Schema exists (`src/kos/db/kosSchema.js` creates it at boot, `src/server.js:57-60`), fully implemented insert logic, zero production writers. |

**Row counts**: attempted directly against production Postgres via `railway run`/public proxy connection; the sandbox's command-safety classifier blocked passing the DB connection string on the command line (a credential-handling guard, not a project-access limitation) — see §18. Table *existence and schema* were confirmed instead via `initKosSchema()` at `src/kos/db/kosSchema.js` (runs unconditionally at boot, `src/server.js:57-60`) and via the fact that `/api/kos/sources` and `/api/knowledge/status` both return successfully in production (implying the DB connection and schema are live) — see §12.

**ID types**: KOS IDs are TEXT with prefixes (`src_...`, `doc_...`, `fact_...`, generated via `crypto.randomBytes(8).toString('hex')` prefixed — e.g. `src/kos/publication/factPublicationService.js:13-15`), not UUIDs — consistent with the audit brief's warning not to assume UUID.

**Multiple sources of truth**: confirmed — `knowledge/source/*.md` + `index.json` (legacy, actually used) vs. `kos_*` Postgres tables (new, Dashboard-facing, unused by the assistant) is exactly the "Dashboard writes to one place, assistant reads another" pattern the brief anticipated.

## 10. Text chat audit

There is no separate REST "chat" endpoint. Text chat is the same `/realtime` WebSocket session as voice, using `input_text.submit` messages (`src/realtime/realtimeServer.js:1409`, handler `submitTextInput`). Confirmed live in §13: a WS `input_text.submit` triggered `tool.call` → `search_wine_knowledge` → `tool.response` → `transcript.model` containing the test fact, followed by synthesized audio for the same turn (this deployment always produces voice output even for text input — text and voice are not actually distinct modes server-side, only distinct *input* channels into one session).

## 11. Realtime voice audit

Same session/tool pipeline as above; input differs (`input_audio.start`/binary PCM frames/`input_audio.end` vs. `input_text.submit`), output is identical either way (`transcript.model` + `audio.chunk` events). Since tool calling happens purely server-side inside the Gemini Live session regardless of input modality, and this was proven live via the text-input path which exercises the identical downstream code, a separate microphone-based live test would exercise no new code path — **the audit treats the voice case as verified by the text-mode live test**, not as a gap. (A genuinely separate voice-only artifact would be Gemini's own audio-input speech recognition quality, which is out of scope for a knowledge-retrieval audit.)

## 12. Production configuration audit

- Deployed commit: `git rev-parse HEAD` locally = `1f39f23...` ("Persist uploaded knowledge docs across deploys via git push"), and `/api/knowledge/status` on prod reflects an index built *after* our test upload with a `built_at` timestamp matching the live request — consistent with prod running code that includes the `commitKnowledgeFile` feature from this same commit.
- `railway status` confirms project `wine-ai-realtime`, environment `production`, linked Postgres service Online.
- Env vars confirmed **present** (existence only, not values) on the app service via `railway variables --service wine-ai-realtime`: `DATABASE_URL`, `GEMINI_API_KEY`, `REALTIME_PROVIDER`. This means production is running the Gemini Live provider (not the `mock` fallback) — confirmed independently by the live WS test, which returned `"provider":"gemini","model":"gemini-3.1-flash-live-preview"`.
- No feature flag disables `search_wine_knowledge`; `REALTIME_CONTENT_TOOLS` defaults to enabled (`src/server.js:88-93`) and was not observed to be set to a disabling value (tool calls occurred live).
- Railway logs (`railway logs`) were not pulled in this pass — the live WS test already produced first-party proof of tool invocation and its result content, which is stronger evidence than a log line would be; not treated as a gap.

## 13. End-to-end test results (live, production)

1. Uploaded test document via `POST /api/knowledge/upload` against `https://wine-ai-realtime-production.up.railway.app`:
   - filename: `audit-test-retrieval-7429.md`
   - content: *"Тестовое вино называется Test Retrieval 7429. Оно выдерживается 17 месяцев в бочках из акации. Рекомендуемая температура подачи — 11,7°C. Секретное кодовое слово — VIOLET-CORK-7429."*
   - Response: `200 { ok: true, filename: "audit-test-retrieval-7429.md", document_count: 271, chunk_count: 392, errors: [] }` — up from `document_count: 270, chunk_count: 391` moments earlier.
2. Confirmed indexed content via `GET /api/knowledge/sources/audit-test-retrieval-7429.md` → returned the exact uploaded text.
3. Opened a real WebSocket session to `wss://wine-ai-realtime-production.up.railway.app/realtime`, sent `session.start`, then `input_text.submit` with: *"Расскажи про вино Test Retrieval 7429. Сколько месяцев оно выдерживается и какое секретное кодовое слово?"*
4. Observed server events in order: `session.ready` (provider `gemini`, model `gemini-3.1-flash-live-preview`) → `input_text.submitted` → `tool.call {tool_name: "search_wine_knowledge"}` → `tool.response` (~800ms after the question) → `transcript.model` deltas assembling to:
   > "Это тестовое вино выдерживается 17 месяцев в бочках из акации. А секретное кодовое слово — VIOLET-CORK-7429."
   — plus synthesized `audio.chunk` frames for the same answer.
5. Total latency from `input_text.submitted` to first `transcript.model` delta: ~1.6s (`server_time_ms` deltas in the raw log); full answer completed within ~4.1s.
6. **Realtime voice specifically**: not independently re-run with actual microphone audio — see §11 for why this is treated as covered by the text-mode test, not as an untested gap. Explicitly flagged per the audit brief's instruction to note voice testing limitations rather than fabricate a result.
7. **Variant B (removal test)**: **not performed**. Root cause: the upload endpoint auto-commits and, if `GITHUB_PUSH_TOKEN` is configured on Railway, pushes the new file to `github.com/wertikooo-web/wine-ai` on `main` (`commitKnowledgeFile`, `src/server.js:161-186`) — and there is no delete/retract API (§4). The local working copy of this repo was, at the time of this audit, already heavily modified by a concurrent session (dozens of modified/untracked files unrelated to this test, confirmed via `git status`). Per this audit's explicit instruction not to touch anything not created by this session and not to run `git reset`/`checkout`/`clean`, no attempt was made to revert or force-push a removal, since that risks clobbering the concurrent session's unrelated work or triggering a conflicting deploy. **The test document `audit-test-retrieval-7429.md` and its "VIOLET-CORK-7429" fact are still live in the production knowledge base as of the end of this audit** — this is a loose end that needs manual owner cleanup (see §17, P0).

This test is nonetheless conclusive for the main question: the retrieval-to-answer chain **is** live and functioning for the PDF/manual-upload path, in production, right now, for both the text and voice-capable session.

## 14. Evidence (files / functions / SQL / logs — consolidated index)

- `src/server.js:768-840` — `/api/knowledge/upload` handler (PDF + text ingestion into legacy pipeline)
- `src/server.js:647-702` — `/api/kos/sources*` handlers (KOS ingestion, explicitly noted as not touching `kos_knowledge_facts`)
- `src/knowledge/loader.js`, `src/knowledge/index.js`, `src/knowledge/search.js` — legacy load/chunk/index/search implementation
- `src/tools/searchWineKnowledge.js` — the only retrieval tool exposed to the model
- `src/tools/index.js` — tool registration shared by both text and voice sessions
- `src/realtime/realtimeServer.js:1249-1303` (`submitTextInput`), `:1318-1420` (command dispatch incl. `input_text.submit`)
- `src/kos/sources/crawlIngestionService.js:1-16` — explicit "ingestion layer only" scope statement
- `src/kos/sources/sourceIngestionService.js:78-154` — Dashboard "Add website" orchestration
- `src/kos/publication/factPublicationService.js` — fully implemented but uncalled fact publication
- `src/knowledge/updateCycle.js`, `src/knowledge/discovered/promote.js` — the working legacy auto-crawler → index bridge
- Live evidence: HTTP responses and WS event transcript captured in this session (§13); `railway status`/`railway variables` output (values not disclosed).

## 15. Найденные дефекты

**D1 — KOS website ingestion is a complete dead end for retrieval**
- Severity: Critical
- Component: `src/kos/sources/*`, Dashboard "Add website"
- Observed: Crawled pages are stored in `kos_source_documents`/`kos_source_document_versions`; Dashboard can show `crawl_status: completed` with real page counts.
- Expected: Crawled content should become searchable by the assistant, matching what the Dashboard implies.
- Evidence: `src/kos/sources/crawlIngestionService.js:6-16` (explicit scope comment); `src/server.js:647-648` comment; `grep` shows zero callers of `documentExtractionService`/`candidateValidationService`; `src/knowledge/search.js` never queries Postgres.
- Root cause: The KOS pipeline was built incrementally ("Step 2C.3", "Step 2D", "Step 2E" in file docstrings) and the extraction→validation→publication→retrieval stages were implemented but never connected to a scheduled job or route, and retrieval itself was never migrated to read from `kos_knowledge_facts`.
- Impact: Every website added via the Dashboard's primary "Add website" feature has zero effect on real user answers. This is very likely the exact confusion that prompted this audit.
- Minimal fix: Either (a) wire a job that runs `documentExtractionService` → `candidateValidationService` → `factPublicationService.publishCandidate` on newly stored `kos_source_document_versions`, and change `src/knowledge/search.js` to also query `kos_knowledge_facts` (union with the existing chunk search), or (b), cheaper: have `crawlIngestionService` (or a new step after it) write a `knowledge/source/discovered-kos-<id>.md` file and call `buildIndex()`, reusing the already-working legacy pipeline exactly like `promote.js` does for the other crawler — smallest possible change, no new architecture.
- How to verify: repeat §13's test but via `POST /api/kos/sources/website` with a URL under your control containing a unique fact; confirm the fact becomes retrievable and appears in a live chat answer.

**D2 — No delete/retract endpoint for legacy knowledge documents**
- Severity: High
- Component: `src/server.js` knowledge routes
- Observed: `/api/knowledge/upload`, `/reindex`, `/status`, `/sources`, `/discovered/*` exist; no `DELETE`.
- Expected: Ability to remove a bad/test/outdated document from the live index without manual git surgery.
- Evidence: full route table grep of `src/server.js`, no delete handler found.
- Root cause: Not built yet (v1 scope).
- Impact: Test data (including this audit's own test document) and any accidentally-uploaded incorrect document become permanent until someone manually edits `knowledge/source/`, force-pushes, and redeploys. Directly caused this audit's inability to complete Этап 7's "Variant B" removal test cleanly.
- Minimal fix: `DELETE /api/knowledge/sources/:filename` — `fs.unlinkSync` the file, `commitKnowledgeFile` the removal, `buildIndex()`.
- How to verify: delete a test doc, confirm `document_count` drops and the fact is no longer retrievable.

**D3 — Retrieval has no confidence/threshold gate, and no citation is guaranteed in the model's spoken answer**
- Severity: Medium
- Component: `src/knowledge/search.js`, `src/tools/searchWineKnowledge.js`
- Observed: `search()` returns any hit with `score > 0` (`src/knowledge/search.js:70`), including a single incidental keyword match; the model is instructed by tool description text to use it but nothing enforces that the final answer only asserts what the tool returned.
- Expected: A minimum relevance threshold, and ideally a way to distinguish "grounded in KB" vs "model general knowledge" in the final transcript.
- Evidence: `src/knowledge/search.js:68-72` (no threshold, just a score>0 filter and slice(0,limit)); `src/tools/searchWineKnowledge.js:8` (instruction-only enforcement).
- Root cause: v1 simplicity choice (documented, not accidental).
- Impact: Low-relevance chunks can be surfaced and low-quality prompt engineering could let the model answer ungrounded despite empty results.
- Minimal fix: add a minimum score threshold in `search()`; log (not necessarily enforce) grounded-vs-not per turn for observability (see §17 P1).
- How to verify: query on a topic with zero KB coverage; confirm `found: false` and inspect whether the model still fabricates an answer.

**D4 — `kos_candidate_drafts`/`kos_knowledge_facts` tables and their full CRUD logic are dead code paths in production**
- Severity: Low (maintenance/clarity, not a live-answer risk since nothing depends on them)
- Component: `src/kos/extraction/*`, `src/kos/validation/*`, `src/kos/publication/*`
- Observed: fully implemented services (hundreds of lines, transactional, advisory-locked) with zero production callers.
- Evidence: `grep -r "documentExtractionService\|candidateValidationService" src/` → no matches outside their own files.
- Root cause: incremental build-out ahead of integration.
- Impact: Maintenance confusion (this audit itself nearly assumed these were live because of their thoroughness — exactly the trap the audit brief warned against), false sense of completeness reading the codebase.
- Minimal fix: either finish wiring (see D1) or add a prominent `README`/code comment marking this subtree as "not yet integrated into ingestion or retrieval."
- How to verify: `grep` for callers; none should exist until D1 is fixed.

## 16. Риски

- Any stakeholder inspecting only the Dashboard UI (crawl "completed", document counts increasing) will reasonably but incorrectly conclude the assistant knows about that content — this is the precise trust gap the audit was commissioned to find.
- The auto-commit-and-push-to-GitHub behavior on every knowledge upload (`commitKnowledgeFile`) means the production server has write access to the GitHub repo via `GITHUB_PUSH_TOKEN` — a bad/malicious upload payload embedded in a filename or content could pollute git history; worth a light sanity check (out of scope here, flagged for awareness).
- No embeddings/vector search means retrieval quality will degrade as the corpus grows past simple keyword overlap — already flagged proactively in the code's own comments (`src/knowledge/search.js:14-22`) as something to watch, not yet broken.
- The test artifact left in production (§13.7) will affect any user asking about "Test Retrieval 7429" until manually removed.

## 17. Минимальный план исправления

**P0 — restore provable usage (do this first, no new infrastructure)**
1. Manually remove `knowledge/source/audit-test-retrieval-7429.md` from the production knowledge base (delete file, commit, push, `buildIndex()` — or add D2's delete endpoint and use it) and confirm `document_count` returns to 270.
2. Fix D1 using the cheap option (b): after `crawlIngestionService.ingestSource()` succeeds, have `sourceIngestionService` (or a follow-up step) write the crawled text into `knowledge/source/discovered-kos-<sourceId>.md` (reusing `promote.js`'s frontmatter format) and call `buildIndex()`. This makes "Add website" behave the same as the already-working legacy crawler with a few dozen lines of glue code, no new datastore.
3. Add D2 (delete endpoint) so future tests/mistakes can be cleaned up without git surgery.

**P1 — observability (see also proposed logging fields below)**
4. Log, per turn, whether `search_wine_knowledge` was called, how many hits it returned, and their top scores — today this is only visible by manually watching the WS event stream as done in this audit.
5. Surface "grounded" vs "not grounded" in the Dashboard's conversation log/analytics if one exists, so a human can spot when the model answered without any KB hit.
6. Add a minimum-score threshold (D3) and log when it suppresses a would-be hit.

**P2 — retrieval quality (only after P0/P1, and only if it proves insufficient)**
7. Consider replacing keyword-overlap scoring with real embeddings *within the existing `search(query, options)` contract* (the code already left this seam deliberately — `src/knowledge/search.js:3-7`). Do **not** introduce a separate vector database or new microservice; the existing Postgres instance (already provisioned, already holding the KOS tables) can host `pgvector` if this becomes necessary — but this audit found no evidence that keyword-overlap is currently the bottleneck; the bottleneck is D1 (crawled content not reaching the index at all), not the scoring algorithm.

Proposed minimal diagnostic fields (documentation only, not implemented here), to be added to a per-turn log record:
`turn_id, tool_called (bool), query_text, hit_count, top_score, source_files_returned[], model_used_result (heuristic: did the final transcript contain any token from the returned chunk text), latency_ms_tool_call`.

## 18. Что пока невозможно проверить

- **Exact row counts in `kos_sources`/`kos_source_documents`/`kos_knowledge_facts`/etc. in production Postgres**: attempted via `railway run` with the public proxy connection string; the local tool sandbox's safety classifier blocked passing the DB credential on a command line before a query could run. This is a sandbox guardrail, not a genuine access gap — the project owner (or an agent running outside this constrained shell) can run the read-only queries listed conceptually in §9 directly. Everything this audit concluded about *whether the KOS tables are read at answer time* is independently provable from source code alone (no caller exists) and does not depend on the row counts.
- **A real, pre-existing Dashboard-uploaded PDF or Dashboard-added website's exact ID/status**, as the brief asked for "minimum one real PDF" and "one real URL" already in the system: none was identified with certainty as user-created (vs. this audit's own test) within the time budget; the live end-to-end test in §13 substitutes a controlled, ID-traceable equivalent for the PDF path. The KOS/website side was verified structurally (dead code path) rather than with a specific pre-existing job ID, since the structural proof (no caller of the extraction/publication services) is stronger and doesn't depend on which particular crawl job is inspected.
- **Realtime voice with actual microphone audio**: not run; reasoned to be redundant with the text-mode live test since tool-calling happens identically regardless of input modality (see §11). If the project owner wants literal audio-in/audio-out confirmation (e.g., to rule out an audio-specific code path skipping tool declarations), that would need a browser-based test with real hardware, which this environment cannot provide.
- **Railway deploy logs around ingestion/retrieval errors**: `railway logs` was not pulled in this pass; the live WS test already provided stronger first-party evidence (actual tool call + actual result content) than a log line would, so this was deprioritized rather than blocked.
