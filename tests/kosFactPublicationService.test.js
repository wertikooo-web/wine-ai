/**
 * Unit Test Suite for FactPublicationService (Step 2D)
 */

const assert = require('assert');
const { publishCandidate } = require('../src/kos/publication/factPublicationService');
const { MemoryPgEngine } = require('./helpers/postgresMemoryDb');

async function runTests() {
    console.log('Running FactPublicationService unit tests...');
    const memoryDb = new MemoryPgEngine();
    memoryDb.reset();

    // Setup validated draft records in DB
    await memoryDb.query(
        `INSERT INTO kos_candidate_drafts (
            id, parsed_document_id, entity_type, entity_ref, field_path, raw_value, normalized_value,
            value_type, evidence_drafts, confidence_score, extractor_name, extractor_version,
            source_document_id, source_document_version_id, identity_hash
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
            'draft_v1', 'parsed_001', 'Wine', JSON.stringify({ key: 'Negru_de_Purcari' }), 'alcohol', '13.5%',
            JSON.stringify(13.5), 'number',
            JSON.stringify({ charStart: 10, charEnd: 15, text: '13.5%' }), 0.9,
            'labelExtractor', '1.0.0', 'doc_001', 'ver_001', 'hash_v1'
        ]
    );

    // Mark status as 'validated'
    await memoryDb.query(`UPDATE kos_candidate_drafts SET status = $1 WHERE id = $2`, ['validated', null, 'draft_v1']);

    // Test A: First Publication (Version 1)
    const pubRes1 = await publishCandidate({ candidateDraftId: 'draft_v1', dependencies: { db: memoryDb } });
    assert.strictEqual(pubRes1.status, 'published');
    assert.strictEqual(pubRes1.version, 1);
    assert.strictEqual(Boolean(pubRes1.factId), true);
    console.log('  ✓ Published validated candidate as version 1');

    // Test B: Idempotency (Repeat publication returns already_published)
    const pubResRepeat = await publishCandidate({ candidateDraftId: 'draft_v1', dependencies: { db: memoryDb } });
    assert.strictEqual(pubResRepeat.status, 'already_published');
    assert.strictEqual(pubResRepeat.factId, pubRes1.factId);
    console.log('  ✓ Verified publication idempotency on repeat call');

    // Test C: Value Change -> Version 2 Increment without overwriting
    await memoryDb.query(
        `INSERT INTO kos_candidate_drafts (
            id, parsed_document_id, entity_type, entity_ref, field_path, raw_value, normalized_value,
            value_type, evidence_drafts, confidence_score, extractor_name, extractor_version,
            source_document_id, source_document_version_id, identity_hash
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
            'draft_v2', 'parsed_001', 'Wine', JSON.stringify({ key: 'Negru_de_Purcari' }), 'alcohol', '14.0%',
            JSON.stringify(14.0), 'number',
            JSON.stringify({ charStart: 10, charEnd: 15, text: '14.0%' }), 0.9,
            'labelExtractor', '1.0.0', 'doc_001', 'ver_001', 'hash_v2'
        ]
    );
    await memoryDb.query(`UPDATE kos_candidate_drafts SET status = $1 WHERE id = $2`, ['validated', null, 'draft_v2']);

    const pubRes2 = await publishCandidate({ candidateDraftId: 'draft_v2', dependencies: { db: memoryDb } });
    assert.strictEqual(pubRes2.status, 'published');
    assert.strictEqual(pubRes2.version, 2, 'New value for same identity scope must increment version to 2');
    console.log('  ✓ Value update incremented version to 2 without overwriting version 1');

    // Test D: Reject Unvalidated Draft Publication
    await memoryDb.query(
        `INSERT INTO kos_candidate_drafts (
            id, parsed_document_id, entity_type, entity_ref, field_path, raw_value, normalized_value,
            value_type, evidence_drafts, confidence_score, extractor_name, extractor_version,
            source_document_id, source_document_version_id, identity_hash
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
            'draft_pending', 'parsed_001', 'Wine', JSON.stringify({ key: 'Negru' }), 'vintage', '2022',
            JSON.stringify(2022), 'number',
            JSON.stringify({ charStart: 0, charEnd: 4, text: '2022' }), 0.9,
            'labelExtractor', '1.0.0', 'doc_001', 'ver_001', 'hash_pending'
        ]
    );

    await assert.rejects(
        async () => {
            await publishCandidate({ candidateDraftId: 'draft_pending', dependencies: { db: memoryDb } });
        },
        /KOS_CANNOT_PUBLISH_UNVALIDATED_CANDIDATE/,
        'Should reject publishing pending/unvalidated draft'
    );
    console.log('  ✓ Publishing pending/unvalidated candidate rejected');

    console.log('ALL FactPublicationService tests PASSED!');
    return { assertionCount: 4 };
}

module.exports = { run: runTests };

if (require.main === module) {
    runTests().catch(err => {
        console.error('Test failed:', err);
        process.exit(1);
    });
}
