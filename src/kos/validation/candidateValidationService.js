/**
 * CandidateValidationService (Step 2D)
 * 
 * Performs deterministic technical validation on a CandidateDraft (zero AI).
 * Validates existence of ParsedDocument & Source provenance, evidence offset bounds,
 * exact evidence text matching, required fields, and JSON-supported data types.
 * Updates draft status to 'validated' or 'rejected'.
 */

const defaultDb = require('../../knowledge/db');

/**
 * Validates a candidate draft by ID.
 * 
 * @param {Object} params
 * @param {string} params.candidateDraftId - ID of the kos_candidate_drafts record
 * @param {Object} [params.dependencies] - Injectable db, logger
 * @returns {Promise<{ status: 'validated'|'rejected', draftId: string, errors: Array|null }>}
 */
async function validateCandidateDraft({ candidateDraftId, dependencies = {} }) {
    if (!candidateDraftId) {
        throw new Error('KOS_INVALID_ARGUMENT: candidateDraftId is required');
    }

    const db = dependencies.db || defaultDb;

    // 1. Load CandidateDraft
    const draftRes = await db.query(
        `SELECT * FROM kos_candidate_drafts WHERE id = $1`,
        [candidateDraftId]
    );

    if (!draftRes || !draftRes.rows || draftRes.rows.length === 0) {
        throw new Error(`KOS_CANDIDATE_DRAFT_NOT_FOUND: CandidateDraft ${candidateDraftId} not found`);
    }

    const draft = draftRes.rows[0];
    const errors = [];

    // 2. Load ParsedDocument
    const parsedRes = await db.query(
        `SELECT * FROM kos_parsed_documents WHERE id = $1`,
        [draft.parsed_document_id]
    );

    const parsedDoc = (parsedRes && parsedRes.rows) ? parsedRes.rows[0] : null;
    if (!parsedDoc) {
        errors.push({ code: 'PARSED_DOCUMENT_NOT_FOUND', message: `ParsedDocument ${draft.parsed_document_id} does not exist` });
    }

    // 3. Load SourceDocument & Version
    if (draft.source_document_id) {
        const docRes = await db.query(
            `SELECT * FROM kos_source_documents WHERE id = $1`,
            [draft.source_document_id]
        );
        if (!docRes || !docRes.rows || docRes.rows.length === 0) {
            errors.push({ code: 'SOURCE_DOCUMENT_NOT_FOUND', message: `SourceDocument ${draft.source_document_id} does not exist` });
        }
    }

    if (draft.source_document_version_id) {
        const verRes = await db.query(
            `SELECT * FROM kos_source_document_versions WHERE id = $1`,
            [draft.source_document_version_id]
        );
        if (!verRes || !verRes.rows || verRes.rows.length === 0) {
            errors.push({ code: 'SOURCE_VERSION_NOT_FOUND', message: `SourceDocumentVersion ${draft.source_document_version_id} does not exist` });
        }
    }

    // 4. Validate evidence offsets & exact text match
    const evidence = typeof draft.evidence_drafts === 'string' ? JSON.parse(draft.evidence_drafts) : draft.evidence_drafts;
    if (!evidence || typeof evidence.charStart !== 'number' || typeof evidence.charEnd !== 'number') {
        errors.push({ code: 'INVALID_EVIDENCE_OFFSETS', message: 'Evidence is missing valid charStart or charEnd offsets' });
    } else if (parsedDoc) {
        const canonicalText = parsedDoc.canonical_text;
        if (evidence.charStart < 0 || evidence.charEnd <= evidence.charStart || evidence.charEnd > canonicalText.length) {
            errors.push({
                code: 'EVIDENCE_OFFSETS_OUT_OF_BOUNDS',
                message: `Offsets [${evidence.charStart}, ${evidence.charEnd}] are out of canonical text bounds [0, ${canonicalText.length}]`,
            });
        } else {
            const sliced = canonicalText.slice(evidence.charStart, evidence.charEnd);
            if (sliced !== evidence.text) {
                errors.push({
                    code: 'EVIDENCE_TEXT_MISMATCH',
                    message: `Evidence text '${evidence.text}' does not match canonicalText slice '${sliced}' at range [${evidence.charStart}, ${evidence.charEnd}]`,
                });
            }
        }
    }

    // 5. Validate required fields
    if (!draft.entity_type || typeof draft.entity_type !== 'string' || draft.entity_type.trim() === '') {
        errors.push({ code: 'MISSING_ENTITY_TYPE', message: 'CandidateDraft entity_type is required' });
    }

    if (!draft.field_path || typeof draft.field_path !== 'string' || draft.field_path.trim() === '') {
        errors.push({ code: 'MISSING_FIELD_PATH', message: 'CandidateDraft field_path is required' });
    }

    if (draft.raw_value === null || draft.raw_value === undefined || String(draft.raw_value).trim() === '') {
        errors.push({ code: 'MISSING_RAW_VALUE', message: 'CandidateDraft raw_value is required' });
    }

    // 6. Validate JSON value type
    const validTypes = ['string', 'number', 'boolean', 'array', 'object'];
    const normValue = typeof draft.normalized_value === 'string' && (draft.normalized_value.startsWith('{') || draft.normalized_value.startsWith('['))
        ? JSON.parse(draft.normalized_value)
        : draft.normalized_value;
    const actualType = Array.isArray(normValue) ? 'array' : typeof normValue;

    if (!validTypes.includes(actualType)) {
        errors.push({ code: 'INVALID_VALUE_TYPE', message: `Value type '${actualType}' is not a valid JSON-supported type` });
    }

    // 7. Validate entity identity
    const entityRef = typeof draft.entity_ref === 'string' ? JSON.parse(draft.entity_ref) : draft.entity_ref;
    if (!entityRef || (typeof entityRef !== 'object' && typeof entityRef !== 'string')) {
        errors.push({ code: 'INVALID_ENTITY_IDENTITY', message: 'CandidateDraft entity_ref is missing or invalid' });
    }

    // 8. Update DB status
    const status = errors.length === 0 ? 'validated' : 'rejected';
    const validationErrorsJson = errors.length > 0 ? JSON.stringify(errors) : null;

    await db.query(
        `UPDATE kos_candidate_drafts SET status = $1, validation_errors = $2 WHERE id = $3`,
        [status, validationErrorsJson, candidateDraftId]
    );

    return {
        status,
        draftId: candidateDraftId,
        errors: errors.length > 0 ? errors : null,
    };
}

module.exports = {
    validateCandidateDraft,
};
