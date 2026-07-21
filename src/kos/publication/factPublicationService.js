/**
 * FactPublicationService (Step 2D)
 * 
 * Publishes validated candidate drafts into the permanent Knowledge Store (kos_knowledge_facts).
 * Enforces transaction safety, creates evidence in kos_fact_evidences, and handles versioning
 * for updated property values without overwriting history.
 */

const crypto = require('crypto');
const defaultDb = require('../../knowledge/db');

function generateId(prefix = 'fact') {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Publishes a validated candidate draft into Published Knowledge.
 * 
 * @param {Object} params
 * @param {string} params.candidateDraftId - ID of the kos_candidate_drafts record
 * @param {Object} [params.dependencies] - Injectable db, logger
 * @returns {Promise<{ status: 'published'|'already_published'|'unchanged', factId: string, version: number, fact: Object }>}
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

    // 3. Idempotency Check: Already published candidate draft
    const publishedCheck = await db.query(
        `SELECT * FROM kos_knowledge_facts WHERE candidate_draft_id = $1`,
        [candidateDraftId]
    );

    if (publishedCheck && publishedCheck.rows && publishedCheck.rows.length > 0) {
        const existingFact = publishedCheck.rows[0];
        return {
            status: 'already_published',
            factId: existingFact.id,
            version: existingFact.version,
            fact: existingFact,
        };
    }

    // 4. Resolve identity scope & source provenance
    const entityRef = typeof draft.entity_ref === 'string' ? JSON.parse(draft.entity_ref) : draft.entity_ref;
    const entityKey = typeof entityRef === 'string' ? entityRef : (entityRef.key || entityRef.name || entityRef.slug || 'winery_main');
    const entityType = draft.entity_type;
    const property = draft.field_path;

    if (!entityType || !entityKey || !property) {
        throw new Error(`KOS_INVALID_ENTITY_IDENTITY: Cannot publish fact with incomplete identity (entityType=${entityType}, entityKey=${entityKey}, property=${property})`);
    }

    // Resolve winery_id from SourceDocument
    let wineryId = 'winery_purcari'; // Default scope for domain
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

    // Prepare Evidence & Value
    const evidence = typeof draft.evidence_drafts === 'string' ? JSON.parse(draft.evidence_drafts) : draft.evidence_drafts;
    const rawValue = draft.raw_value;
    const normValue = typeof draft.normalized_value === 'string' && (draft.normalized_value.startsWith('{') || draft.normalized_value.startsWith('['))
        ? JSON.parse(draft.normalized_value)
        : (draft.normalized_value || rawValue);

    // 5. Concurrency-Safe Publication Transaction
    await db.query('BEGIN');
    try {
        // Lock existing facts for this scope
        const existingFactsRes = await db.query(
            `SELECT * FROM kos_knowledge_facts WHERE winery_id = $1 AND entity_type = $2 AND entity_key = $3 AND property = $4 FOR UPDATE`,
            [wineryId, entityType, entityKey, property]
        );

        const existingFacts = (existingFactsRes && existingFactsRes.rows) ? existingFactsRes.rows : [];
        let nextVersion = 1;

        if (existingFacts.length > 0) {
            const maxVersion = Math.max(...existingFacts.map(f => Number(f.version || 1)));
            const latestFact = existingFacts.find(f => Number(f.version) === maxVersion) || existingFacts[existingFacts.length - 1];

            // If value is identical, return unchanged without creating duplicate version
            let latestVal = latestFact.value_json;
            if (typeof latestVal === 'string') {
                try { latestVal = JSON.parse(latestVal); } catch (_) { /* keep raw string */ }
            }
            if (JSON.stringify(latestVal) === JSON.stringify(normValue)) {
                await db.query('COMMIT');
                return {
                    status: 'unchanged',
                    factId: latestFact.id,
                    version: latestFact.version,
                    fact: latestFact,
                };
            }

            nextVersion = maxVersion + 1;
        }

        // Create evidence record in kos_fact_evidences
        const evidenceId = generateId('ev');
        await db.query(
            `INSERT INTO kos_fact_evidences (
                id, source_id, winery_id, evidence_text, start_offset, end_offset
            ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                evidenceId,
                draft.source_document_id || 'src_default',
                wineryId,
                evidence.text,
                evidence.charStart,
                evidence.charEnd,
            ]
        );

        // Create published fact in kos_knowledge_facts
        const factId = generateId('fact');
        const insertFactRes = await db.query(
            `INSERT INTO kos_knowledge_facts (
                id, winery_id, knowledge_type, entity_type, entity_id, field_key,
                value_json, normalized_value, extraction_confidence, source_authority,
                freshness_score, verification_status, source_id, evidence_id,
                extractor_name, extractor_version, entity_key, property,
                source_document_version_id, parsed_document_id, candidate_draft_id, version
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
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
                evidenceId,
                draft.extractor_name,
                draft.extractor_version,
                entityKey,
                property,
                draft.source_document_version_id,
                draft.parsed_document_id,
                candidateDraftId,
                nextVersion,
            ]
        );

        await db.query('COMMIT');

        const publishedFact = (insertFactRes && insertFactRes.rows) ? insertFactRes.rows[0] : null;

        return {
            status: 'published',
            factId,
            version: nextVersion,
            fact: publishedFact,
        };
    } catch (err) {
        await db.query('ROLLBACK');
        throw err;
    }
}

module.exports = {
    publishCandidate,
};
