# domains/knowledge-retrieval.md — Knowledge retrieval and search

## Trigger

When the task involves: knowledge base, search, embeddings, semantic search, KOS pipeline, document ingestion, fact publication, knowledge source management.

## Core files

- `src/knowledge/search.js` — hybrid keyword + semantic search with RRF
- `src/knowledge/searchMode.js` — runtime search mode toggle (keyword/hybrid/disabled)
- `src/knowledge/embeddings.js` — Gemini embeddings client
- `src/knowledge/db.js` — PostgreSQL connection + schema init
- `src/knowledge/loader.js` — document loading, frontmatter parsing, chunking
- `src/knowledge/index.js` — index building (buildIndex/loadIndex)
- `src/tools/searchWineKnowledge.js` — function calling tool for wine knowledge

## Key concepts

### Search pipeline

```text
documents (knowledge/source/*.md)
  → loader.js (frontmatter parsing + paragraph chunking)
  → index.js (buildIndex() → knowledge/index/index.json)
  → search.js (keyword IDF + optional semantic pgvector via RRF)
  → tools/searchWineKnowledge.js (function calling)
  → [KNOWLEDGE CONTEXT] block in prompt
```

### Search modes

- `keyword` — IDF-weighted keyword search (always available)
- `hybrid` — keyword + semantic (pgvector + Gemini embeddings) via Reciprocal Rank Fusion
- `disabled` — master kill switch (search returns empty hits)

Mode persisted to Postgres `app_settings` table. Runtime-toggleable from Dashboard.

### Keyword search

- IDF weighting: `idf(t) = ln((N+1)/(df(t)+1)) + 1`
- Title/metadata match weighted 4x over body match
- Stopwords filtered (multi-language: RU, RO, EN, plus corpus-specific like "вино", "молдова")
- Cached per index build (keyed on `index.built_at`)

### Semantic search

- Model: `gemini-embedding-001` (768 dimensions)
- Task types: `RETRIEVAL_QUERY` (search), `RETRIEVAL_DOCUMENT` (backfill)
- Distance threshold: `SEMANTIC_MAX_DISTANCE = 0.6` (cosine distance)
- Fallback: if semantic search errors, falls back to keyword-only (never throws)

### Reciprocal Rank Fusion

- Standard RRF constant `k=60` (Cormack et al. 2009)
- Combines keyword and semantic ranked lists without score normalization
- `rrfScore = 1 / (k + rank + 1)`

### Knowledge tool

`search_wine_knowledge` function calling tool:
- Bounded query variant generation (max 5 variants)
- Handles spelled-out vs numeral forms ("семь тысяч" ↔ "7000")
- Strips interrogative/filler words
- Returns structured results with text, title, source, confidence, relevance_score
- Diagnostic logging: query, language, finalStatus, attempts, hit_count, top_hits

### KOS pipeline (Knowledge Object Store)

```text
src/kos/sources/ → website crawling (Dashboard "Add website")
src/kos/extraction/ → document → candidate facts
src/kos/validation/ → candidate verification
src/kos/publication/ → fact publication to kos_knowledge_facts
```

**Critical known state (as of 2026-07-24 audit):** The KOS ingestion pipeline writes raw crawled pages to `kos_source_documents` but extraction → validation → publication stages are not wired into any scheduled job or route. Crawled content is invisible to the assistant's answer path. The `search()` function only reads from `knowledge/index/index.json`.

## Gotchas

- `search(query, options)` is the public contract for `src/tools/*`. Its signature must not change without updating all callers.
- The knowledge base starting empty is a normal, expected state — not an error.
- Small talk / greetings never hit retrieval. Factual wine questions do.
- `SCORING_STOPWORDS` includes corpus-specific terms ("вино", "молдова") that carry low discriminative signal in a wine-focused corpus.
- `buildQueryVariants()` is bounded to max 5 variants to prevent unbounded expansion.
- `search_wine_knowledge` tool instruction explicitly tells the model NOT to answer from memory alone when the tool is available.

## Tests

- `tests/knowledgeSearch.test.js` — keyword search, IDF weighting, stopwords
- `tests/searchWineKnowledgeFallback.test.js` — bounded retrieval, fallback behavior
