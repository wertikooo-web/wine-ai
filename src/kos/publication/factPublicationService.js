/**
 * FactPublicationService (Step 2D - Refined Publication)
 * 
 * Publishes validated candidate drafts into Published Knowledge (kos_knowledge_facts).
 * Uses PostgreSQL advisory transaction lock for concurrency safety, links evidence
 * in kos_fact_evidences, supports multiple evidences per fact version, and increments
 * version only when fact value changes.
 */

const crypto = require('crypto');
const defaultDb = require('../../knowledge/db');

function generateId(prefix = 'fact') {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function hashScopeToBigIntSigned(scopeKeyStr) {
    const hashBuf = crypto.createHash('sha256').update(scopeKeyStr).digest();
    const bigintVal = hashBuf.readBigInt64BE(0);
    return bigintVal.toString();
}

function parseJsonIfNeeded(val) {
    if (val === undefined || val === null) return val;
    if (typeof val === 'string') {
        try {
            return JSON.parse(val);
        } catch (_) {
            return val;
        }
    }
    return val;
}

/**
 * Publishes a validated candidate draft into Published Knowledge.
 * 
 * @param {Object} params
 * @param {string} params.candidateDraftId - ID of the kos_candidate_drafts record
 * @param {Object} [params.dependencies] - Injectable db, logger
 * @returns {Promise<{ status: 'published'|'already_published', factId: string, version: number, fact: Object, evidence: Object }>}
 */
async function publishCandidate({ candidateDraftId, dependencies = {} }) {
    if (!candidateDraftId) {
        throw new Error('KOS_INVALID_ARGUMENT: candidateDraftId is required');
    }

    const db = dependencies.db || defaultDb;

    // 1. Fetch CandidateDraft
    const draftRes = await db.query(
        `SELECT * FROM kos_candidate_drafts WHERE id = $1`,
        [candidateDraftId]
    );

    if (!draftRes || !draftRes.rows || draftRes.rows.length === 0) {
        throw new Error(`KOS_CANDIDATE_DRAFT_NOT_FOUND: CandidateDraft ${candidateDraftId} not found`);
    }

    const draft = draftRes.rows[0];

    // 2. Enforce status === 'validated'
    if (draft.status !== 'validated') {
        throw new Error(`KOS_CANNOT_PUBLISH_UNVALIDATED_CANDIDATE: CandidateDraft ${candidateDraftId} has status '${draft.status}'`);
    }

    // 3. Idempotency Check: Already published via evidence record
    const evidenceCheck = await db.query(
        `SELECT * FROM kos_fact_evidences WHERE candidate_draft_id = $1`,
        [candidateDraftId]
    );

    if (evidenceCheck && evidenceCheck.rows && evidenceCheck.rows.length > 0) {
        const existingEv = evidenceCheck.rows[0];
        const factRes = await db.query(
            `SELECT * FROM kos_knowledge_facts WHERE id = $1`,
            [existingEv.fact_id]
        );
        const existingFact = (factRes && factRes.rows && factRes.rows[0]) ? factRes.rows[0] : null;
        return {
            status: 'already_published',
            factId: existingEv.fact_id,
            version: existingFact ? existingFact.version : 1,
            fact: existingFact,
            evidence: existingEv,
        };
    }

    // 4. Resolve identity scope & source provenance
    const entityRef = parseJsonIfNeeded(draft.entity_ref);
    const entityKey = typeof entityRef === 'string' ? entityRef : (entityRef.key || entityRef.name || entityRef.slug || 'winery_main');
    const entityType = draft.entity_type;
    const property = draft.field_path;

    if (!entityType || !entityKey || !property) {
        throw new Error(`KOS_INVALID_ENTITY_IDENTITY: Cannot publish fact with incomplete identity (entityType=${entityType}, entityKey=${entityKey}, property=${property})`);
    }

    // Resolve winery_id from SourceDocument
    let wineryId = 'winery_purcari'; // Default domain scope
    if (draft.source_document_id) {
        const docRes = await db.query(
            `SELECT * FROM kos_source_documents WHERE id = $1`,
            [draft.source_document_id]
        );
        if (docRes && docRes.rows && docRes.rows.length > 0) {
            const srcDoc = docRes.rows[0];
            const sourceRes = await db.query(
                `SELECT * FROM kos_sources WHERE id = $1`,
                [srcDoc.source_id]
            );
            if (sourceRes && sourceRes.rows && sourceRes.rows[0] && sourceRes.rows[0].winery_id) {
                wineryId = sourceRes.rows[0].winery_id;
            }
        }
    }

    // Prepare Evidence & Normalized Value
    const evidenceObj = parseJsonIfNeeded(draft.evidence_drafts);
    const rawValue = draft.raw_value;
    const normValue = parseJsonIfNeeded(draft.normalized_value) ?? rawValue;

    // Compute Advisory Lock Key for (wineryId, entityType, entityKey, property)
    const scopeKey = JSON.stringify({ wineryId, entityType, entityKey, property });
    const lockKey = hashScopeToBigIntSigned(scopeKey);

    // 5. Concurrency-Safe Publication Transaction
    await db.query('BEGIN');
    try {
        // Transactional Advisory Lock guarantees single-thread processing per identity scope
        await db.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

        // Query existing published facts for scope
        const existingFactsRes = await db.query(
            `SELECT * FROM kos_knowledge_facts WHERE winery_id = $1 AND entity_type = $2 AND entity_key = $3 AND property = $4 ORDER BY version DESC`,
            [wineryId, entityType, entityKey, property]
        );

        const existingFacts = (existingFactsRes && existingFactsRes.rows) ? existingFactsRes.rows : [];
        let targetFact = null;
        let version = 1;

        if (existingFacts.length === 0) {
            // Case A: No existing fact -> create version 1
            version = 1;
            const factId = generateId('fact');
            const insertFactRes = await db.query(
                `INSERT INTO kos_knowledge_facts (
                    id, winery_id, knowledge_type, entity_type, entity_id, field_key,
                    value_json, normalized_value, extraction_confidence, source_authority,
                    freshness_score, verification_status, source_id,
                    extractor_name, extractor_version, entity_key, property,
                    source_document_version_id, parsed_document_id, candidate_draft_id, version
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
                RETURNING *`,
                [
                    factId,
                    wineryId,
                    'extracted_fact',
                    entityType,
                    entityKey,
                    property,
                    JSON.stringify(normValue),
                    String(rawValue),
                    draft.confidence_score || 0.9,
                    1.0,
                    1.0,
                    'approved',
                    draft.source_document_id || 'src_default',
                    draft.extractor_name,
                    draft.extractor_version,
                    entityKey,
                    property,
                    draft.source_document_version_id,
                    draft.parsed_document_id,
                    candidateDraftId,
                    version,
                ]
            );
            targetFact = (insertFactRes && insertFactRes.rows) ? insertFactRes.rows[0] : null;
        } else {
            const latestFact = existingFacts[0];
            const latestVal = parseJsonIfNeeded(latestFact.value_json);

            if (JSON.stringify(latestVal) === JSON.stringify(normValue)) {
                // Case B: Value matches -> link new evidence to existing fact without incrementing version
                targetFact = latestFact;
                version = Number(latestFact.version || 1);
            } else {
                // Case C: Value changed -> increment version
                const maxVer = Math.max(...existingFacts.map(f => Number(f.version || 1)));
                version = maxVer + 1;
                const factId = generateId('fact');
                const insertFactRes = await db.query(
                    `INSERT INTO kos_knowledge_facts (
                        id, winery_id, knowledge_type, entity_type, entity_id, field_key,
                        value_json, normalized_value, extraction_confidence, source_authority,
                        freshness_score, verification_status, source_id,
                        extractor_name, extractor_version, entity_key, property,
                        source_document_version_id, parsed_document_id, candidate_draft_id, version
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
                    RETURNING *`,
                    [
                        factId,
                        wineryId,
                        'extracted_fact',
                        entityType,
                        entityKey,
                        property,
                        JSON.stringify(normValue),
                        String(rawValue),
                        draft.confidence_score || 0.9,
                        1.0,
                        1.0,
                        'approved',
                        draft.source_document_id || 'src_default',
                        draft.extractor_name,
                        draft.extractor_version,
                        entityKey,
                        property,
                        draft.source_document_version_id,
                        draft.parsed_document_id,
                        candidateDraftId,
                        version,
                    ]
                );
                targetFact = (insertFactRes && insertFactRes.rows) ? insertFactRes.rows[0] : null;
            }
        }

        // Always create kos_fact_evidences linking fact & candidate_draft
        const evidenceId = generateId('ev');
        const insertEvRes = await db.query(
            `INSERT INTO kos_fact_evidences (
                id, fact_id, candidate_draft_id, source_id, winery_id, evidence_text, quote,
                start_offset, end_offset, char_start, char_end, parsed_document_id,
                source_document_id, source_document_version_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING *`,
            [
                evidenceId,
                targetFact.id,
                candidateDraftId,
                draft.source_document_id || 'src_default',
                wineryId,
                evidenceObj.text,
                evidenceObj.text,
                evidenceObj.charStart,
                evidenceObj.charEnd,
                evidenceObj.charStart,
                evidenceObj.charEnd,
                draft.parsed_document_id,
                draft.source_document_id,
                draft.source_document_version_id,
            ]
        );

        await db.query('COMMIT');

        const createdEvidence = (insertEvRes && insertEvRes.rows) ? insertEvRes.rows[0] : null;

        return {
            status: 'published',
            factId: targetFact.id,
            version,
            fact: targetFact,
            evidence: createdEvidence,
        };
    } catch (err) {
        await db.query('ROLLBACK');
        throw err;
    }
}

module.exports = {
    publishCandidate,
    hashScopeToBigIntSigned,
};
