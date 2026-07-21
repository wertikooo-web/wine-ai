/**
 * Unit Test Suite for DocumentExtractionService (Step 2D)
 */

const assert = require('assert');
const { extractFromParsedDocument, computeCandidateIdentityHash } = require('../src/kos/extraction/documentExtractionService');
const { MemoryPgEngine } = require('./helpers/postgresMemoryDb');

async function runTests() {
    console.log('Running DocumentExtractionService unit tests...');
    const memoryDb = new MemoryPgEngine();
    memoryDb.reset();

    // 1. Setup sample Source, Document, Version, ParsedDocument
    await memoryDb.query(
        `INSERT INTO kos_parsed_documents (id, version_id, document_id, adapter_name, adapter_version, canonical_text, structural_units)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
            'parsed_doc_001',
            'ver_001',
            'doc_001',
            'html',
            '1.0.0+builder-1.0.0',
            'Château Purcari Winery producing Negru de Purcari 2022 with 13.5% alcohol in Ștefan Vodă region.',
            JSON.stringify([
                { type: 'paragraph', text: 'Château Purcari Winery producing Negru de Purcari 2022 with 13.5% alcohol in Ștefan Vodă region.', charStart: 0, charEnd: 96 }
            ])
        ]
    );

    // Test A: Normal Extraction
    const extractRes = await extractFromParsedDocument({
        parsedDocumentId: 'parsed_doc_001',
        extractorName: 'auto',
        dependencies: { db: memoryDb }
    });

    assert.strictEqual(extractRes.parsedDocumentId, 'parsed_doc_001');
    assert.strictEqual(extractRes.totalExtracted > 0, true, 'Should extract at least one candidate draft');
    console.log(`  ✓ Extracted ${extractRes.totalExtracted} drafts from ParsedDocument`);

    // Test B: Offset Invariant Check
    for (const draft of extractRes.drafts) {
        const ev = draft.evidence_drafts;
        const text = 'Château Purcari Winery producing Negru de Purcari 2022 with 13.5% alcohol in Ștefan Vodă region.';
        const slice = text.slice(ev.charStart, ev.charEnd);
        assert.strictEqual(slice, ev.text, `Evidence offset invariant failed for draft ${draft.id}`);
    }
    console.log('  ✓ Verified Primary Offset Invariant across all extracted drafts');

    // Test C: Idempotency (Repeat extraction with same version returns existing drafts)
    const repeatRes = await extractFromParsedDocument({
        parsedDocumentId: 'parsed_doc_001',
        extractorName: 'auto',
        dependencies: { db: memoryDb }
    });

    assert.strictEqual(repeatRes.totalExtracted, extractRes.totalExtracted, 'Repeat extraction should return exact same candidate count');
    console.log('  ✓ Verified idempotency on repeat extraction');

    // Test D: Canonical JSON Identity Hash check with entityType
    const hashA = computeCandidateIdentityHash({
        parsedDocumentId: 'doc1',
        extractorName: 'ext',
        extractorVersion: '1.0',
        entityType: 'Wine',
        entityKey: 'Negru',
        fieldPath: 'vintage',
        charStart: 10,
        charEnd: 20
    });
    const hashB = computeCandidateIdentityHash({
        parsedDocumentId: 'doc1',
        extractorName: 'ext',
        extractorVersion: '1.0',
        entityType: 'Winery', // Different entity type
        entityKey: 'Negru',
        fieldPath: 'vintage',
        charStart: 10,
        charEnd: 20
    });
    assert.notStrictEqual(hashA, hashB, 'Different entityType must yield different identity hashes');
    console.log('  ✓ Verified entityType inclusion in canonical identity hash');

    console.log('ALL DocumentExtractionService tests PASSED!');
    return { assertionCount: 4 };
}

module.exports = { run: runTests };

if (require.main === module) {
    runTests().catch(err => {
        console.error('Test failed:', err);
        process.exit(1);
    });
}
