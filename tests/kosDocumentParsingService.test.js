'use strict';

/**
 * WINE AI KOS - Document Parsing Service Unit Test Suite (Step 2C.4)
 *
 * Verifies:
 * 1. Checksum Mismatch Error (KOS_RAW_CHECKSUM_MISMATCH)
 * 2. Format Adapter resolution based on MIME type
 * 3. Unsupported MIME error (KOS_UNSUPPORTED_MIME_TYPE)
 * 4. Successful parsing flow into ParsedDocument
 * 5. Idempotency Check: repeat parse returns existing ParsedDocument without re-parsing
 * 6. Parser Version update creates new ParsedDocument record
 */

const assert = require('assert');
const crypto = require('crypto');
const { parseDocumentVersion } = require('../src/kos/parsing/documentParsingService');
const { getAdapterForMime } = require('../src/kos/parsing/formatAdapterRegistry');
const { createMemoryPgPool } = require('./helpers/postgresMemoryDb');

async function run() {
    let assertionCount = 0;
    const pool = createMemoryPgPool();

    // 1. Adapter Resolution & Unsupported MIME Test
    assert.strictEqual(getAdapterForMime('text/html').ADAPTER_NAME, 'html_adapter');
    assert.strictEqual(getAdapterForMime('text/plain').ADAPTER_NAME, 'text_adapter');
    assert.strictEqual(getAdapterForMime('application/pdf').ADAPTER_NAME, 'pdf_adapter');
    assert.strictEqual(getAdapterForMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document').ADAPTER_NAME, 'docx_adapter');
    assertionCount += 4;

    assert.throws(() => {
        getAdapterForMime('image/png');
    }, (err) => err.code === 'KOS_UNSUPPORTED_MIME_TYPE');
    assertionCount += 1;

    // 2. Setup Seed Data in Memory DB
    const versionId = 'ver_doc_100';
    const documentId = 'doc_purcari_html';
    const htmlBody = Buffer.from('<html><head><title>Purcari</title></head><body><h1>Purcari Winery</h1><p>Negru de Purcari is legendary.</p></body></html>', 'utf8');
    const checksum = crypto.createHash('sha256').update(htmlBody).digest('hex');

    // Mock Raw Storage
    const mockStorage = {
        getRawDocumentVersion: async (vId) => {
            if (vId === 'ver_corrupted') {
                return { rawBuffer: Buffer.from('Tampered Corrupted Body', 'utf8') };
            }
            return { rawBuffer: htmlBody };
        },
    };

    // Populate Version Table in DB
    await pool.query(
        `INSERT INTO kos_source_document_versions (
            id, document_id, crawl_run_id, checksum_sha256, storage_key, size_bytes, declared_mime_type, detected_mime_type, fetched_at
        ) VALUES ($1, $2, 'run_100', $3, 'raw/test.bin', $4, 'text/html', 'text/html', NOW())`,
        [versionId, documentId, checksum, htmlBody.length]
    );

    // 3. Successful Parsing Flow
    const parsedDoc1 = await parseDocumentVersion({
        versionId,
        dependencies: {
            rawResourceStorage: mockStorage,
            queryClient: pool,
        },
    });

    assert.strictEqual(parsedDoc1.existing, false);
    assert.strictEqual(parsedDoc1.adapter_name, 'html_adapter');
    assert.strictEqual(parsedDoc1.adapter_version, '1.0.0+builder-1.0.0');
    assert.strictEqual(parsedDoc1.metadata.title, 'Purcari');
    assert.strictEqual(parsedDoc1.structural_units.length, 2);
    assertionCount += 5;

    // Verify Primary Offset Invariant
    for (const unit of parsedDoc1.structural_units) {
        const sliced = parsedDoc1.canonical_text.slice(unit.charStart, unit.charEnd);
        assert.strictEqual(sliced, unit.text);
        assertionCount += 1;
    }

    // 4. Idempotency Check: Second call returns existing record without re-parsing
    const parsedDoc2 = await parseDocumentVersion({
        versionId,
        dependencies: {
            rawResourceStorage: mockStorage,
            queryClient: pool,
        },
    });

    assert.strictEqual(parsedDoc2.existing, true);
    assert.strictEqual(parsedDoc2.id, parsedDoc1.id);
    assertionCount += 2;

    // 5. New Builder / Parser Version creates NEW ParsedDocument
    const parsedDocNewBuilder = await parseDocumentVersion({
        versionId,
        overrideAdapterVersion: '1.0.0+builder-2.0.0',
        dependencies: {
            rawResourceStorage: mockStorage,
            queryClient: pool,
        },
    });

    assert.strictEqual(parsedDocNewBuilder.existing, false);
    assert.strictEqual(parsedDocNewBuilder.adapter_version, '1.0.0+builder-2.0.0');
    assert.notStrictEqual(parsedDocNewBuilder.id, parsedDoc1.id);
    assertionCount += 3;

    // 6. Checksum Mismatch Error (KOS_RAW_CHECKSUM_MISMATCH)
    const corruptedVersionId = 'ver_corrupted';
    await pool.query(
        `INSERT INTO kos_source_document_versions (
            id, document_id, crawl_run_id, checksum_sha256, storage_key, size_bytes, declared_mime_type, detected_mime_type, fetched_at
        ) VALUES ($1, $2, 'run_100', 'expected_sha256_hash_value_different', 'raw/corrupted.bin', 100, 'text/html', 'text/html', NOW())`,
        [corruptedVersionId, documentId]
    );

    await assert.rejects(async () => {
        await parseDocumentVersion({
            versionId: corruptedVersionId,
            dependencies: {
                rawResourceStorage: mockStorage,
                queryClient: pool,
            },
        });
    }, (err) => err.code === 'KOS_RAW_CHECKSUM_MISMATCH');
    assertionCount += 1;

    // Confirm NO ParsedDocument was saved for corrupted version
    const { rows: corruptedParsedRows } = await pool.query('SELECT * FROM kos_parsed_documents WHERE version_id = $1', [corruptedVersionId]);
    assert.strictEqual(corruptedParsedRows.length, 0);
    assertionCount += 1;

    console.log(`kosDocumentParsingService.test.js: All ${assertionCount} assertions passed successfully!`);
    return { assertionCount };
}

module.exports = { run };
