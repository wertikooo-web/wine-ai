# contracts/knowledge-search.md — Knowledge search contract

## Interface

```js
search(query: string, options?: {
  limit?: number,        // default 4
  language?: string,     // default null (all languages)
  indexFile?: string,    // default knowledge/index/index.json
}) => Promise<{
  hits: Array<{
    chunk: {
      id: string,
      text: string,
      metadata: {
        title: string,
        winery: string | null,
        region: string | null,
        grape: string | null,
        language: string,
        doc_type: string,
        source: string,
        confidence: string,
        source_file: string,
        chunk_index: number,
        enabled: boolean,
      }
    },
    score: number,       // IDF-weighted relevance score
  }>,
  tookMs: number,        // execution time in milliseconds
  mode: 'keyword' | 'hybrid' | 'disabled',
}>
```

## Contract rules

- `search(query, options)` is the public contract for `src/tools/*`
- Signature must not change without updating all callers
- Empty query returns empty hits (never throws)
- Empty knowledge base returns empty hits (normal expected state)
- Semantic search errors fall back to keyword-only (never throws)
- `mode` reports what actually ran, which can differ from `searchMode.getMode()` if hybrid fell back

## Search modes

- `keyword` — IDF-weighted keyword search (always available)
- `hybrid` — keyword + semantic via RRF (requires pgvector + Gemini embeddings)
- `disabled` — master kill switch (returns empty hits)

## Keyword search behavior

- Tokenization: `/[\p{L}\p{N}]+/gu` (Unicode-aware)
- IDF weighting: `idf(t) = ln((N+1)/(df(t)+1)) + 1`
- Title/metadata match weighted 4x over body match
- Stopwords filtered (multi-language + corpus-specific)
- Cached per index build

## Semantic search behavior

- Model: `gemini-embedding-001` (768 dimensions)
- Distance threshold: `SEMANTIC_MAX_DISTANCE = 0.6`
- Returns top-K by cosine distance (ascending — closer first)
- Fused with keyword results via RRF (`k=60`)

## Tool contract (`search_wine_knowledge`)

```js
impl(args: {
  query: string,         // required, non-empty
  language?: string,     // optional ISO code (ru, ro, en)
}) => Promise<{
  found: boolean,
  status: 'found' | 'not_found' | 'error',
  results: Array<{
    text: string,
    title: string,
    source: string,
    confidence: string,
    language: string,
    relevance_score: number,
  }>,
  instruction?: string,  // only on not_found/error
}>
```

## Tool rules

- Bounded query variant generation (max 5 variants)
- Handles spelled-out vs numeral forms ("семь тысяч" ↔ "7000")
- Strips interrogative/filler words
- Returns structured results with diagnostic logging
- `instruction` field tells the model how to handle not_found/error

## Gotchas

- `search()` signature must not change without updating all callers
- Empty knowledge base is normal, not an error
- Small talk / greetings never hit retrieval
- `buildQueryVariants()` is bounded to prevent unbounded expansion
- `search_wine_knowledge` tool instruction explicitly tells the model NOT to answer from memory alone

## Tests

- `tests/knowledgeSearch.test.js` — keyword search, IDF weighting, stopwords
- `tests/searchWineKnowledgeFallback.test.js` — bounded retrieval, fallback behavior
