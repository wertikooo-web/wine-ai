'use strict';

// Stage 3 verification for the PG-as-source-of-truth migration
// (docs/audits/PG_MIGRATION_PLAN.md): the write path — documents enter
// Postgres through the shared publish service and become searchable chunks.
//
// Covered here (the 9 Stage 3 scenarios):
//   1. upload flow: document row -> published knowledge_chunks rows
//   2. upload -> PG search: search(chunkSource=postgres) finds the content
//   3. idempotent re-upload: same document leaves no duplicates, all unchanged
//   4. update replaces stale chunks: old chunks disabled in the same publish
//   5. embedding error -> no false success (status surfaces the failure)
//   6. PG-only embedding survives backfill/prune (prune keyed to the PG set)
//   7. file path still works (index.json untouched)
//   8. auto chunk source still falls back to file on empty postgres
//   9. searchWineKnowledge contract unchanged

const path = require('path');
const t = require('./helpers/assertions');
const { createMemoryPgPool } = require('./helpers/postgresMemoryDb');
const { chunkDocument } = require('../src/knowledge/loader');
const { chunkToRow, upsertChunkRow, loadChunksFromPostgres } = require('../src/knowledge/chunkStore');
const publishService = require('../src/knowledge/publishService');
const { syncEmbeddings } = require('../scripts/knowledge-embed-backfill');
const { loadChunks, DEFAULT_INDEX_FILE } = require('../src/knowledge/index');
const { search } = require('../src/knowledge/search');
const searchMode = require('../src/knowledge/searchMode');
const db = require('../src/knowledge/db');
const embeddings = require('../src/knowledge/embeddings');
const searchWineKnowledge = require('../src/tools/searchWineKnowledge');

const CHUNKS_DDL = `
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
        chunk_id TEXT PRIMARY KEY,
        source_file TEXT NOT NULL,
        title TEXT, doc_type TEXT, language TEXT, source TEXT, confidence TEXT,
        entity_id TEXT, winery TEXT, region TEXT, grape TEXT, date TEXT,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        chunk_index INT NOT NULL DEFAULT 0,
        text TEXT NOT NULL, content_hash TEXT NOT NULL,
        document_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
`;
const EMBEDDINGS_DDL = `
    CREATE TABLE IF NOT EXISTS knowledge_chunk_embeddings (
        chunk_id TEXT PRIMARY KEY,
        source_file TEXT NOT NULL,
        model TEXT NOT NULL,
        embedding TEXT,
        content_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );
`;

function createPool() {
    const pool = createMemoryPgPool();
    return pool;
}

function docFor(id, body, title) {
    return {
        documentId: id,
        sourceFile: publishService.sourceFileForDocument(id),
        metadata: {
            title: title || `Doc ${id}`,
            language: 'ru',
            doc_type: 'uploaded_text',
            source: 'https://fixture.test',
        },
        body,
    };
}

function para(repeat, minChars = 600) {
    let s = '';
    while (s.length < minChars) s += repeat;
    return s.slice(0, minChars);
}

// Three ~600-char paragraphs -> 3 chunks; two paragraphs -> 2 chunks. chunkText
// pushes a paragraph when the running candidate reaches maxChars (1200).
const pCricova = para('Винодельня Cricova производит вина. ');
const pFeteasca = para('Сорт Fetească Neagră растет в регионе Codru. ');
const pCellar = para('В погребах Cricova выдерживается вино. ');
const BODY_A = [pCricova, pFeteasca, pCellar].join('\n\n');
const BODY_B = [pCricova, pFeteasca].join('\n\n');

// Rebuild a chunk exactly as publishService does, so tests can assert the id
// scheme matches the read path (loader.js chunkDocument).
function chunkDoc(doc) {
    return chunkDocument({
        sourceFile: doc.sourceFile,
        metadata: {
            title: doc.metadata.title,
            language: doc.metadata.language,
            doc_type: doc.metadata.doc_type,
            source: doc.metadata.source,
            confidence: 'unverified',
        },
        body: doc.body,
        validation: { sourceFile: doc.sourceFile, missing: [], unknown: [] },
    });
}

async function run() {
    // ------------------------------------------------------------------ //
    // 1. Upload flow: document row -> published knowledge_chunks rows.
    // ------------------------------------------------------------------ //
    const pool1 = createPool();
    await pool1.query(CHUNKS_DDL);
    await pool1.query(EMBEDDINGS_DDL);

    // Emulate the server.js upload route's document write (kos_sources
    // 'uploaded' source + kos_source_documents upsert) before publishing.
    await pool1.query(
        `INSERT INTO kos_sources (id, name, seed_url, normalized_origin, source_type, trust_level, created_at, updated_at)
         VALUES ('uploaded', 'Dashboard Uploads', 'https://uploaded.local', 'uploaded.local', 'upload', 'unverified', NOW(), NOW())`
    );
    const docA = docFor('doc_upload1', BODY_A);
    await pool1.query(
        `INSERT INTO kos_source_documents (
            id, source_id, requested_url, canonical_url, title, content_type, content_length,
            document_type, content_hash, normalized_text, language, status, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', NOW(), NOW())`,
        [
            docA.documentId, 'uploaded', 'uploaded://fixture.md', 'uploaded://fixture.md',
            'Fixture', 'text/plain', Buffer.byteLength(BODY_A), 'uploaded_text',
            'hash', BODY_A, 'ru',
        ]
    );

    const r1 = await publishService.publishDocument({ pool: pool1, ...docA, embed: false });
    t.equal(r1.status, 'published', 'publish status is published');
    t.equal(r1.chunkCount, 3, 'fixture A produces 3 chunks');
    t.equal(r1.inserted, 3, 'first publish inserts every chunk');

    const docRows = await pool1.query('SELECT id FROM kos_source_documents');
    t.equal(docRows.rows.length, 1, 'upload flow persisted the document row');

    const stored1 = (await loadChunksFromPostgres(pool1)).chunks.filter((c) => c.metadata.source_file === docA.sourceFile);
    t.equal(stored1.length, 3, 'upload flow persisted chunks to knowledge_chunks');
    const expectedA = chunkDoc(docA).map((c) => c.id);
    t.deepEqual(stored1.map((c) => c.id), expectedA, 'chunk ids match the read-path scheme (postgres:<id>#index)');

    // ------------------------------------------------------------------ //
    // 2. Upload -> PG search: search(chunkSource=postgres) finds it.
    // ------------------------------------------------------------------ //
    const origMode = searchMode.getMode();
    const origIsEnabled = db.isEnabled;
    const origGetPool = db.getPool;
    try {
        db.isEnabled = () => true;
        db.getPool = () => pool1;
        searchMode.setMode('keyword');
        const pgSearch = await search('Cricova', { language: 'ru', limit: 4, chunkSource: 'postgres' });
        t.equal(pgSearch.diagnostics.chunkSource, 'postgres', 'search resolves postgres chunks');
        t.ok(pgSearch.hits.length > 0, 'search over postgres chunks returns hits');
        t.ok(pgSearch.hits.some((h) => h.chunk.metadata.source_file === docA.sourceFile), 'uploaded content found via PG search');
    } finally {
        searchMode.setMode(origMode);
        db.isEnabled = origIsEnabled;
        db.getPool = origGetPool;
    }

    // ------------------------------------------------------------------ //
    // 3. Idempotent re-upload: nothing duplicated, all chunks unchanged.
    // ------------------------------------------------------------------ //
    const r2 = await publishService.publishDocument({ pool: pool1, ...docA, embed: false });
    t.equal(r2.inserted, 0, 're-upload inserts nothing');
    t.equal(r2.updated, 0, 're-upload updates nothing');
    t.equal(r2.unchanged, 3, 're-upload leaves every chunk unchanged');
    const after2 = (await loadChunksFromPostgres(pool1)).chunks.filter((c) => c.metadata.source_file === docA.sourceFile);
    t.equal(after2.length, 3, 'no duplicate chunks after re-upload');

    // ------------------------------------------------------------------ //
    // 4. Update replaces stale chunks (old chunks disabled in the same tx).
    // ------------------------------------------------------------------ //
    const docB = { ...docA, body: BODY_B };
    const r3 = await publishService.publishDocument({ pool: pool1, ...docB, embed: false });
    t.equal(r3.chunkCount, 2, 'updated body produces 2 chunks');
    t.equal(r3.disabled, 1, 'the dropped chunk is disabled');
    t.equal(r3.unchanged, 2, 'the two kept chunks are unchanged');

    const staleId = chunkDoc(docA).map((c) => c.id)[2];
    const after3 = (await loadChunksFromPostgres(pool1)).chunks.filter((c) => c.metadata.source_file === docA.sourceFile);
    const stale = after3.find((c) => c.id === staleId);
    t.ok(stale, 'the old chunk row still exists for audit');
    t.equal(stale.metadata.enabled, false, 'old chunk is disabled (not served by search)');
    t.equal(after3.filter((c) => c.metadata.enabled !== false).length, 2, 'only the new chunks are enabled');

    // ------------------------------------------------------------------ //
    // 5. Embedding error -> no false success.
    // ------------------------------------------------------------------ //
    const pool5 = createPool();
    await pool5.query(CHUNKS_DDL);
    await pool5.query(EMBEDDINGS_DDL);
    const badEmbeds = Object.assign({}, embeddings, {
        isEnabled: () => true,
        embedTexts: async () => {
            const err = new Error('gemini_down');
            err.code = 'gemini_down';
            throw err;
        },
    });
    const doc5 = docFor('doc_embed_fail', BODY_A);
    const r5 = await publishService.publishDocument({ pool: pool5, ...doc5, embed: true, embeddingsClient: badEmbeds });
    t.equal(r5.status, 'published_embedding_failed', 'embedding failure is surfaced, not a silent success');
    t.equal(r5.embedFailed, 3, 'all 3 chunks reported as embed-failed');
    const chunks5 = (await loadChunksFromPostgres(pool5)).chunks;
    t.equal(chunks5.length, 3, 'chunks still persisted — the failure never rolled back the publish');

    // ------------------------------------------------------------------ //
    // 6. PG-only embedding survives backfill/prune (prune keyed to PG set).
    // ------------------------------------------------------------------ //
    const pool6 = createPool();
    await pool6.query(CHUNKS_DDL);
    await pool6.query(EMBEDDINGS_DDL);
    const doc6 = docFor('doc_pg_only', BODY_A);
    const pgChunks = chunkDoc(doc6);
    for (const chunk of pgChunks) {
        const row = chunkToRow(chunk);
        row.document_id = doc6.documentId;
        await upsertChunkRow(pool6, row);
    }
    // Already-embedded PG-only chunk + one stale embedding for a gone chunk.
    await pool6.query(
        `INSERT INTO knowledge_chunk_embeddings (chunk_id, source_file, model, embedding, content_hash) VALUES ($1,$2,$3,$4,$5)`,
        [pgChunks[0].id, doc6.sourceFile, 'test-model', '[0.1,0.2]', embeddings.embeddingContentHash(pgChunks[0])]
    );
    await pool6.query(
        `INSERT INTO knowledge_chunk_embeddings (chunk_id, source_file, model, embedding, content_hash) VALUES ($1,$2,$3,$4,$5)`,
        ['stale_chunk_id', 'old.md', 'test-model', '[0.1,0.2]', 'deadbeef']
    );

    const fakeEmbedClient = Object.assign({}, embeddings, {
        embedTexts: async (texts) => texts.map((_, i) => [0.1, 0.2, i]),
    });
    const syncResult = await syncEmbeddings({ pool: pool6, chunks: pgChunks, embeddingsClient: fakeEmbedClient });
    t.equal(syncResult.pruned, 1, 'only the stale embedding is pruned');
    const { rows: embRows } = await pool6.query('SELECT chunk_id FROM knowledge_chunk_embeddings');
    const embIds = embRows.map((r) => r.chunk_id);
    t.ok(embIds.includes(pgChunks[0].id), 'PG-only embedding survives backfill/prune');
    t.ok(!embIds.includes('stale_chunk_id'), 'stale embedding removed');
    for (const chunk of pgChunks) {
        t.ok(embIds.includes(chunk.id), `every PG-only chunk ends up embedded (${chunk.id})`);
    }

    // ------------------------------------------------------------------ //
    // 7. File path still works (index.json untouched, file source default).
    // ------------------------------------------------------------------ //
    const fileResult = await loadChunks({ source: 'file', indexFile: DEFAULT_INDEX_FILE, log: () => {} });
    t.equal(fileResult.source, 'file', 'file chunk source still resolves');
    t.ok(fileResult.chunks.length > 0, 'file index still loads');

    // ------------------------------------------------------------------ //
    // 8. Auto source still falls back to file on an empty postgres table.
    // ------------------------------------------------------------------ //
    const pool8 = createPool();
    await pool8.query(CHUNKS_DDL);
    const warns = [];
    const autoResult = await loadChunks({
        source: 'auto', pool: pool8, indexFile: DEFAULT_INDEX_FILE,
        log: () => {}, warn: (m) => warns.push(m),
    });
    t.equal(autoResult.source, 'file', 'auto falls back to file when postgres is empty');
    t.equal(autoResult.fallback, 'postgres_empty', 'fallback reason is postgres_empty');
    t.ok(warns.some((m) => /chunk source: file/.test(m) && /empty/.test(m)), 'fallback is warned, not silent');

    // ------------------------------------------------------------------ //
    // 9. searchWineKnowledge contract unchanged.
    // ------------------------------------------------------------------ //
    t.equal(searchWineKnowledge.declaration.name, 'search_wine_knowledge', 'tool name unchanged');
    t.equal(typeof searchWineKnowledge.declaration.description, 'string', 'tool description is a string');
    t.deepEqual(searchWineKnowledge.declaration.parameters.required, ['query'], 'tool requires only query');
    const toolResult = await searchWineKnowledge.impl({ query: 'Фетяска Нягрэ' }, {});
    t.equal(typeof toolResult.found, 'boolean', 'impl returns found boolean');
    t.ok(['found', 'not_found', 'error'].includes(toolResult.status), 'impl returns a valid status');
    t.ok(Array.isArray(toolResult.results), 'impl returns a results array');
    for (const r of toolResult.results) {
        for (const key of ['text', 'title', 'source', 'confidence', 'language', 'relevance_score']) {
            t.ok(key in r, `result entry has key "${key}"`);
        }
    }
    t.equal(toolResult.status, 'found', 'real query still resolves to found');

    console.log('knowledgePublish.test.js: Stage 3 passed (publish, idempotency, replace, embedding status, PG prune, contract preservation)');
}

module.exports = { run };
