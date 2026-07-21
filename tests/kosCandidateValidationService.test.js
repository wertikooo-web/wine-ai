/**
 * Unit Test Suite for CandidateValidationService (Step 2D)
 */

const assert = require('assert');
const { validateCandidateDraft } = require('../src/kos/validation/candidateValidationService');
const { MemoryPgEngine } = require('./helpers/postgresMemoryDb');

async function runTests() {
    console.log('Running CandidateValidationService unit tests...');
    const memoryDb = new MemoryPgEngine();
    memoryDb.reset();

    // 1. Setup sample records in memory DB
    await memoryDb.query(
        `INSERT INTO kos_source_documents (id, source_id, requested_url, canonical_url) VALUES ($1, $2, $3, $4)`,
        ['doc_001', 'src_001', 'https://purcari.wine', 'https://purcari.wine/']
    );

    await memoryDb.query(
        `INSERT INTO kos_source_document_versions (id, document_id, checksum_sha256, storage_key, size_bytes, declared_mime_type, detected_mime_type, http_headers, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        ['ver_001', 'doc_001', 'sha256_mock', 'storage/key', 100, 'text/html', 'text/html', '{}', new Date().toISOString()]
    );

    const canonicalText = 'Purcari Winery producing Negru de Purcari 2022.';
    await memoryDb.query(
        `INSERT INTO kos_parsed_documents (id, version_id, document_id, adapter_name, adapter_version, canonical_text, structural_units)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['parsed_001', 'ver_001', 'doc_001', 'html', '1.0.0', canonicalText, '[]']
    );

    // Draft A: Valid candidate draft
    await memoryDb.query(
        `INSERT INTO kos_candidate_drafts (
            id, parsed_document_id, entity_type, entity_ref, field_path, raw_value, normalized_value,
            value_type, evidence_drafts, confidence_score, extractor_name, extractor_version,
            source_document_id, source_document_version_id, identity_hash
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
            'draft_valid', 'parsed_001', 'Wine', JSON.stringify({ key: 'Negru' }), 'vintage', '2022',
            JSON.stringify(2022), 'number',
            JSON.stringify({ charStart: 42, charEnd: 46, text: '2022' }), 0.9,
            'labelValueExtractor', '1.0.0', 'doc_001', 'ver_001', 'hash_valid'
        ]
    );

    // Draft B: Invalid evidence offset mismatch
    await memoryDb.query(
        `INSERT INTO kos_candidate_drafts (
            id, parsed_document_id, entity_type, entity_ref, field_path, raw_value, normalized_value,
            value_type, evidence_drafts, confidence_score, extractor_name, extractor_version,
            source_document_id, source_document_version_id, identity_hash
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
            'draft_invalid_offset', 'parsed_001', 'Wine', JSON.stringify({ key: 'Negru' }), 'vintage', '2022',
            JSON.stringify(2022), 'number',
            JSON.stringify({ charStart: 0, charEnd: 7, text: 'WRONG_TEXT' }), 0.9,
            'labelValueExtractor', '1.0.0', 'doc_001', 'ver_001', 'hash_invalid'
        ]
    );

    // Test A: Validate Valid Draft
    const resA = await validateCandidateDraft({ candidateDraftId: 'draft_valid', dependencies: { db: memoryDb } });
    if (resA.status !== 'validated') console.log('resA errors:', resA.errors);
    assert.strictEqual(resA.status, 'validated');
    assert.strictEqual(resA.errors, null);
    console.log('  ✓ Valid candidate correctly validated');

    // Test B: Validate Invalid Offset Draft
    const resB = await validateCandidateDraft({ candidateDraftId: 'draft_invalid_offset', dependencies: { db: memoryDb } });
    assert.strictEqual(resB.status, 'rejected');
    assert.strictEqual(resB.errors.length > 0, true);
    assert.strictEqual(resB.errors[0].code, 'EVIDENCE_TEXT_MISMATCH');
    console.log('  ✓ Invalid evidence offset correctly rejected with structured error');

    console.log('ALL CandidateValidationService tests PASSED!');
    return { assertionCount: 2 };
}

module.exports = { run: runTests };

if (require.main === module) {
    runTests().catch(err => {
        console.error('Test failed:', err);
        process.exit(1);
    });
}
