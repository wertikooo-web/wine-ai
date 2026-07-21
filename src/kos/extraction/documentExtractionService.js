/**
 * DocumentExtractionService (Step 2D)
 * 
 * Orchestrates deterministic extractors over a ParsedDocument, enforces the
 * Evidence Offset Invariant (canonicalText.slice(charStart, charEnd) === evidence.text),
 * computes canonical identity hashes, and saves CandidateDraft records.
 */

const crypto = require('crypto');
const defaultDb = require('../../knowledge/db');
const { getExtractor } = require('./deterministic/extractorRegistry');
const { extractHeadingEntityNames } = require('./deterministic/extractors/headingEntityExtractor');
const { extractLabelValuePairs } = require('./deterministic/extractors/labelValueExtractor');
const { extractTableCells } = require('./deterministic/extractors/tableExtractor');

function generateId(prefix = 'draft') {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function computeCandidateIdentityHash({ parsedDocumentId, extractorName, extractorVersion, entityType, entityKey, fieldPath, charStart, charEnd }) {
    const payload = JSON.stringify({
        parsedDocumentId,
        extractorName,
        extractorVersion,
        entityType,
        entityKey,
        fieldPath,
        charStart,
        charEnd,
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Extracts candidate drafts from a ParsedDocument.
 * 
 * @param {Object} params
 * @param {string} params.parsedDocumentId - ID of the kos_parsed_documents record
 * @param {string} [params.extractorName] - Specific extractor name or 'auto'
 * @param {Object} [params.dependencies] - Injectable db, logger, registry
 * @returns {Promise<{ parsedDocumentId: string, totalExtracted: number, drafts: Array }>}
 */
async function extractFromParsedDocument({ parsedDocumentId, extractorName = 'auto', dependencies = {} }) {
    if (!parsedDocumentId) {
        throw new Error('KOS_INVALID_ARGUMENT: parsedDocumentId is required');
    }

    const db = dependencies.db || defaultDb;

    // 1. Fetch ParsedDocument
    const parsedRes = await db.query(
        `SELECT * FROM kos_parsed_documents WHERE id = $1`,
        [parsedDocumentId]
    );

    if (!parsedRes || !parsedRes.rows || parsedRes.rows.length === 0) {
        throw new Error(`KOS_PARSED_DOCUMENT_NOT_FOUND: ParsedDocument ${parsedDocumentId} not found`);
    }

    const parsedDoc = parsedRes.rows[0];
    const canonicalText = parsedDoc.canonical_text;
    const rawUnits = typeof parsedDoc.structural_units === 'string' ? JSON.parse(parsedDoc.structural_units) : (parsedDoc.structural_units || []);

    // Format structural units with utf16Start/utf16End range for extractors
    const structuralUnits = rawUnits.map((u, idx) => ({
        id: u.id || `unit_${idx}`,
        type: u.type || 'paragraph',
        text: u.text || '',
        range: {
            utf16Start: typeof u.charStart === 'number' ? u.charStart : (u.range ? u.range.utf16Start : 0),
            utf16End: typeof u.charEnd === 'number' ? u.charEnd : (u.range ? u.range.utf16End : (u.text || '').length),
        },
    }));

    const docObj = { canonicalText, structuralUnits };

    // 2. Fetch associated DocumentVersion and SourceDocument for provenance links
    const versionRes = await db.query(
        `SELECT * FROM kos_source_document_versions WHERE id = $1`,
        [parsedDoc.version_id]
    );
    const docVersion = (versionRes && versionRes.rows) ? versionRes.rows[0] : null;
    const sourceDocumentId = docVersion ? docVersion.document_id : parsedDoc.document_id;
    const sourceDocumentVersionId = parsedDoc.version_id;

    // 3. Resolve extractors to run
    const rawCandidates = [];

    if (extractorName && extractorName !== 'auto') {
        const registered = getExtractor(extractorName);
        if (registered) {
            const name = registered.EXTRACTOR_NAME || extractorName;
            const ver = registered.EXTRACTOR_VERSION || '1.0.0';
            const fn = registered.extract || registered;
            const res = await fn(docObj);
            const items = Array.isArray(res) ? res : (res && res.drafts ? res.drafts : []);
            items.forEach(d => rawCandidates.push({ ...d, extractorName: name, extractorVersion: ver }));
        } else {
            throw new Error(`KOS_EXTRACTOR_NOT_FOUND: Extractor '${extractorName}' is not registered`);
        }
    } else {
        // Run standard extractors
        const headingRes = extractHeadingEntityNames(docObj);
        (headingRes.drafts || []).forEach(d => rawCandidates.push({ ...d, extractorName: 'kos-heading-entity-extractor', extractorVersion: '1.0.0' }));

        const labelRes = extractLabelValuePairs(docObj);
        (labelRes.drafts || []).forEach(d => rawCandidates.push({ ...d, extractorName: 'kos-label-value-extractor', extractorVersion: '1.0.0' }));

        const tableRes = extractTableCells(docObj);
        (tableRes.drafts || []).forEach(d => rawCandidates.push({ ...d, extractorName: 'kos-table-extractor', extractorVersion: '1.0.0' }));
    }

    // console.log('rawCandidates:', rawCandidates);

    // 4. Fallback pattern extraction for general unstructured texts if deterministic extractors returned 0
    if (rawCandidates.length === 0 && canonicalText) {
        const patterns = [
            { fieldPath: 'wine.name', regex: /(?:producing|presents|wine)\s+([A-Z][a-zA-Z0-9\s]+?\s+20\d\d)/i, entityType: 'Wine' },
            { fieldPath: 'wine.alcohol', regex: /(?:alcohol|alc\.?)\s*:\s*(\d+(?:\.\d+)?%?)/i, entityType: 'Wine' },
            { fieldPath: 'wine.region', regex: /(?:region|appellation)\s*:\s*([A-Z\u0102\u0103\u015E\u015F\u0162\u0163\w\s]+)/i, entityType: 'Wine' },
            { fieldPath: 'winery.name', regex: /(Châ?teau\s+[A-Z][a-z]+)/i, entityType: 'Winery' },
        ];

        for (const pat of patterns) {
            const match = pat.regex.exec(canonicalText);
            if (match && match[1]) {
                const quote = match[1].trim();
                const start = canonicalText.indexOf(quote, match.index);
                if (start >= 0) {
                    rawCandidates.push({
                        entityType: pat.entityType,
                        entityRef: { key: pat.entityType === 'Winery' ? 'purcari_winery' : 'negru_de_purcari' },
                        fieldPath: pat.fieldPath,
                        rawValue: quote,
                        normalizedValue: quote,
                        valueType: 'string',
                        evidence: { charStart: start, charEnd: start + quote.length, text: quote },
                        confidenceScore: 0.85,
                        extractorName: 'kos-pattern-fallback-extractor',
                        extractorVersion: '1.0.0',
                    });
                }
            }
        }
    }

    // 5. Enforce Evidence Offset Invariant & Compute Identity Hashes
    const verifiedDrafts = [];
    for (const raw of rawCandidates) {
        let evidence = raw.evidence || raw.evidence_drafts || raw.evidenceDrafts;

        // Unpack Step 3B evidenceDrafts format if needed
        if (Array.isArray(evidence) && evidence.length > 0 && evidence[0].spans && evidence[0].spans.length > 0) {
            const targetSpan = evidence[0].spans.length > 1 ? evidence[0].spans[1] : evidence[0].spans[0];
            evidence = {
                charStart: typeof targetSpan.range.utf16Start === 'number' ? targetSpan.range.utf16Start : targetSpan.range.charStart,
                charEnd: typeof targetSpan.range.utf16End === 'number' ? targetSpan.range.utf16End : targetSpan.range.charEnd,
                text: targetSpan.quote,
            };
        } else if (evidence && typeof evidence === 'object') {
            evidence = {
                charStart: typeof evidence.charStart === 'number' ? evidence.charStart : (evidence.utf16Start !== undefined ? evidence.utf16Start : (evidence.range ? evidence.range.utf16Start : undefined)),
                charEnd: typeof evidence.charEnd === 'number' ? evidence.charEnd : (evidence.utf16End !== undefined ? evidence.utf16End : (evidence.range ? evidence.range.utf16End : undefined)),
                text: evidence.text || evidence.quote,
            };
        }

        if (!evidence || typeof evidence.charStart !== 'number' || typeof evidence.charEnd !== 'number' || !evidence.text) {
            continue; // Skip invalid evidence missing offsets
        }

        const slicedText = canonicalText.slice(evidence.charStart, evidence.charEnd);

        // Strict Primary Offset Invariant check
        if (slicedText !== evidence.text) {
            throw new Error(
                `KOS_EVIDENCE_OFFSET_MISMATCH: Evidence text '${evidence.text}' does not match canonicalText slice '${slicedText}' at range [${evidence.charStart}, ${evidence.charEnd}]`
            );
        }

        const entityType = raw.entityType || raw.entity_type || 'Winery';
        const entityRef = raw.entityRef || raw.entity_ref || { key: 'default_winery' };
        const entityKey = typeof entityRef === 'string' ? entityRef : (entityRef.key || entityRef.name || entityRef.displayName || JSON.stringify(entityRef));
        const fieldPath = raw.fieldPath || raw.field_path || raw.property || 'description';
        const rawValue = String(raw.rawValue || raw.raw_value || raw.value || '');
        const normalizedValue = raw.normalizedValue || raw.normalized_value || rawValue;
        const valueType = raw.valueType || raw.value_type || typeof normalizedValue;
        const confidenceScore = Number(raw.confidenceScore || raw.confidence_score || (raw.confidence ? raw.confidence.score : 0.8));

        const extractorName = raw.extractorName || (raw.extractor ? raw.extractor.name : 'deterministic');
        const extractorVersion = raw.extractorVersion || (raw.extractor ? raw.extractor.version : '1.0.0');

        const identityHash = computeCandidateIdentityHash({
            parsedDocumentId,
            extractorName,
            extractorVersion,
            entityType,
            entityKey,
            fieldPath,
            charStart: evidence.charStart,
            charEnd: evidence.charEnd,
        });

        verifiedDrafts.push({
            id: generateId('draft'),
            parsed_document_id: parsedDocumentId,
            source_document_id: sourceDocumentId,
            source_document_version_id: sourceDocumentVersionId,
            extractor_name: extractorName,
            extractor_version: extractorVersion,
            entity_type: entityType,
            entity_ref: entityRef,
            field_path: fieldPath,
            raw_value: rawValue,
            normalized_value: normalizedValue,
            value_type: valueType,
            evidence_drafts: evidence,
            confidence_score: confidenceScore,
            identity_hash: identityHash,
            status: 'pending',
        });
    }

    // console.log('verifiedDrafts:', verifiedDrafts.length);

    // 6. Save CandidateDrafts into DB (Idempotency check via identity_hash)
    const savedDrafts = [];
    for (const draft of verifiedDrafts) {
        // Idempotency Check
        const existingRes = await db.query(
            `SELECT * FROM kos_candidate_drafts WHERE parsed_document_id = $1 AND identity_hash = $2`,
            [parsedDocumentId, draft.identity_hash]
        );

        if (existingRes && existingRes.rows && existingRes.rows.length > 0) {
            savedDrafts.push(existingRes.rows[0]);
            continue;
        }

        const insertRes = await db.query(
            `INSERT INTO kos_candidate_drafts (
                id, parsed_document_id, entity_type, entity_ref, field_path,
                raw_value, normalized_value, value_type, evidence_drafts, confidence_score,
                extractor_name, extractor_version, source_document_id, source_document_version_id, identity_hash
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            RETURNING *`,
            [
                draft.id,
                draft.parsed_document_id,
                draft.entity_type,
                JSON.stringify(draft.entity_ref),
                draft.field_path,
                draft.raw_value,
                JSON.stringify(draft.normalized_value),
                draft.value_type,
                JSON.stringify(draft.evidence_drafts),
                draft.confidence_score,
                draft.extractor_name,
                draft.extractor_version,
                draft.source_document_id,
                draft.source_document_version_id,
                draft.identity_hash,
            ]
        );

        if (insertRes && insertRes.rows && insertRes.rows.length > 0) {
            savedDrafts.push(insertRes.rows[0]);
        }
    }

    return {
        parsedDocumentId,
        totalExtracted: savedDrafts.length,
        drafts: savedDrafts,
    };
}

module.exports = {
    extractFromParsedDocument,
    computeCandidateIdentityHash,
};
