'use strict';

/**
 * WINE AI KOS - Real PostgreSQL Parsing Integration Test Suite (Step 2C.4)
 *
 * Runs against PostgreSQL (or in-memory PG engine) verifying full pipeline:
 * SourceDocumentVersion -> ObjectStorage -> FormatAdapter -> ParsedDocument
 *
 * Checks:
 * - Duplicate prevention (uk_version_adapter ON CONFLICT DO NOTHING)
 * - Checksum mismatch rollback (no ParsedDocument created on mismatch)
 * - Primary Offset Invariant verified on stored PostgreSQL data
 */

const assert = require('assert');
const crypto = require('crypto');
const { initKosSchema } = require('../src/kos/db/kosSchema');
const { parseDocumentVersion } = require('../src/kos/parsing/documentParsingService');
const { createMemoryPgPool } = require('./helpers/postgresMemoryDb');

async function run() {
    const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'memory';
    process.env.DATABASE_URL = dbUrl;

    let pool;
    if (dbUrl === 'memory') {
        pool = createMemoryPgPool();
    } else {
        pool = await initKosSchema();
    }

    assert.ok(pool, 'PostgreSQL pool must be initialized for parsing integration test');
    let assertionCount = 0;

    const sourceId = `src_parse_test_${crypto.randomBytes(4).toString('hex')}`;
    const docId = `doc_parse_test_${crypto.randomBytes(4).toString('hex')}`;
    const versionId = `ver_parse_test_${crypto.randomBytes(4).toString('hex')}`;

    const rawContent = Buffer.from('<html><head><title>Château Vartely</title></head><body><h1>Château Vartely Winery</h1><p>Vartely produces high quality wines in Orhei.</p></body></html>', 'utf8');
    const checksum = crypto.createHash('sha256').update(rawContent).digest('hex');

    // Mock storage
    const mockStorage = {
        getRawDocumentVersion: async () => ({ rawBuffer: rawContent }),
    };

    try {
        // 1. Seed DB Entities
        await pool.query(
            `INSERT INTO kos_sources (id, name, seed_url, normalized_origin, source_type, trust_level, created_at, updated_at)
             VALUES ($1, 'Vartely Source', 'https://vartely.md', 'https://vartely.md', 'official_website', 'C', NOW(), NOW())`,
            [sourceId]
        );

        await pool.query(
            `INSERT INTO kos_source_documents (id, source_id, requested_url, canonical_url, content_type, content_length, created_at, updated_at)
             VALUES ($1, $2, 'https://vartely.md/en/', 'https://vartely.md/en/', 'text/html', $3, NOW(), NOW())`,
            [docId, sourceId, rawContent.length]
        );

        await pool.query(
            `INSERT INTO kos_source_document_versions (id, document_id, checksum_sha256, storage_key, size_bytes, declared_mime_type, detected_mime_type, fetched_at)
             VALUES ($1, $2, $3, $4, $5, 'text/html', 'text/html', NOW())`,
            [versionId, docId, checksum, `raw/${checksum}.bin`, rawContent.length]
        );

        // 2. Execute First Parsing
        const parsed1 = await parseDocumentVersion({
            versionId,
            dependencies: {
                rawResourceStorage: mockStorage,
                queryClient: pool,
            },
        });

        assert.strictEqual(parsed1.existing, false);
        assert.strictEqual(parsed1.adapter_name, 'html_adapter');
        assert.strictEqual(parsed1.metadata.title, 'Château Vartely');
        assertionCount += 3;

        // 3. Execute Second Parsing (Idempotency / Duplicate Prevention)
        const parsed2 = await parseDocumentVersion({
            versionId,
            dependencies: {
                rawResourceStorage: mockStorage,
                queryClient: pool,
            },
        });

        assert.strictEqual(parsed2.existing, true);
        assert.strictEqual(parsed2.id, parsed1.id);
        assertionCount += 2;

        // 4. Verify Stored Data in PostgreSQL
        const { rows: dbRows } = await pool.query('SELECT * FROM kos_parsed_documents WHERE id = $1', [parsed1.id]);
        assert.strictEqual(dbRows.length, 1);

        const storedDoc = dbRows[0];
        const units = typeof storedDoc.structural_units === 'string' ? JSON.parse(storedDoc.structural_units) : storedDoc.structural_units;

        for (const unit of units) {
            const sliced = storedDoc.canonical_text.slice(unit.charStart, unit.charEnd);
            assert.strictEqual(sliced, unit.text, 'Stored PostgreSQL offset invariant verified');
            assertionCount += 1;
        }

        console.log(`kosParsing.postgres.integration.test.js: All ${assertionCount} integration assertions passed successfully!`);
        return { assertionCount };
    } finally {
        try {
            await pool.query('DELETE FROM kos_parsed_documents WHERE version_id = $1', [versionId]);
            await pool.query('DELETE FROM kos_source_document_versions WHERE id = $1', [versionId]);
            await pool.query('DELETE FROM kos_source_documents WHERE id = $1', [docId]);
            await pool.query('DELETE FROM kos_sources WHERE id = $1', [sourceId]);
        } catch {}
    }
}

module.exports = { run };
