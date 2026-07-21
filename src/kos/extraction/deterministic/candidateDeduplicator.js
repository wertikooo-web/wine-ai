'use strict';

/**
 * WINE AI KOS - Post-Validation Candidate Deduplicator (Step 3B Refined)
 *
 * Deduplicates validated candidates using a Canonical JSON Key over normalized values.
 * Merges multi-span evidence for identical normalized values.
 * Emits structured KOS_EXTRACTION_CONFLICTING_VALUES warnings when different normalized values exist for the same field.
 */

const { canonicalJsonStringify } = require('../identity/candidateFingerprint');
const { canonicalizeEntityRef, createValidatedFactCandidate } = require('../contracts/factCandidate');

function buildCanonicalDeduplicationKey(candidate) {
    const payload = {
        entityType: String(candidate.entityType || '').trim().toLowerCase(),
        entityRef: canonicalizeEntityRef(candidate.entityRef),
        fieldPath: String(candidate.fieldPath || '').trim().toLowerCase(),
        normalizedValue: candidate.normalizedValue !== undefined ? candidate.normalizedValue : null,
        extractorName: String(candidate.extractor?.name || '').trim().toLowerCase(),
        extractorVersion: String(candidate.extractor?.version || '').trim().toLowerCase(),
    };

    return canonicalJsonStringify(payload);
}

function deduplicateValidatedCandidates(validatedCandidates = []) {
    if (!Array.isArray(validatedCandidates) || validatedCandidates.length === 0) {
        return { deduplicatedCandidates: [], warnings: [] };
    }

    const map = new Map();
    const entityFieldValuesMap = new Map(); // entityKey|fieldPath -> Set of normalizedValues
    const warnings = [];

    for (const cand of validatedCandidates) {
        // Only valid candidates participate in deduplication & conflict detection
        if (cand.validationStatus !== 'valid') continue;

        const entityKey = `${cand.entityType}|${cand.entityRef?.provisionalKey || cand.entityRef?.id || 'provisional'}`;
        const fieldKey = `${entityKey}|${cand.fieldPath}`;

        if (!entityFieldValuesMap.has(fieldKey)) {
            entityFieldValuesMap.set(fieldKey, new Map());
        }
        const valStr = canonicalJsonStringify(cand.normalizedValue);
        entityFieldValuesMap.get(fieldKey).set(valStr, cand.normalizedValue);

        const dedupKey = buildCanonicalDeduplicationKey(cand);

        if (!map.has(dedupKey)) {
            map.set(dedupKey, {
                candidateId: cand.candidateId,
                entityType: cand.entityType,
                entityRef: cand.entityRef,
                fieldPath: cand.fieldPath,
                value: cand.value,
                normalizedValue: cand.normalizedValue,
                valueType: cand.valueType,
                unit: cand.unit,
                language: cand.language,
                evidence: [...(cand.evidence || [])],
                confidence: cand.confidence,
                extractor: cand.extractor,
                relationshipToExisting: cand.relationshipToExisting,
                validation: cand.validation,
                createdAt: cand.createdAt,
            });
        } else {
            const existing = map.get(dedupKey);
            // Merge evidence
            for (const ev of cand.evidence || []) {
                const isDup = existing.evidence.some((exEv) => exEv.sourceId === ev.sourceId && JSON.stringify(exEv.spans) === JSON.stringify(ev.spans));
                if (!isDup) {
                    existing.evidence.push(ev);
                }
            }
            if (cand.confidence?.score > existing.confidence?.score) {
                existing.confidence = cand.confidence;
            }
        }
    }

    // Check for conflicting normalized values for the same entity + fieldPath
    for (const [fieldKey, valMap] of entityFieldValuesMap.entries()) {
        if (valMap.size > 1) {
            const parts = fieldKey.split('|');
            const values = Array.from(valMap.values());
            warnings.push({
                code: 'KOS_EXTRACTION_CONFLICTING_VALUES',
                message: `Conflicting normalized values detected for field "${parts[2]}".`,
                entityType: parts[0],
                provisionalKey: parts[1],
                fieldPath: parts[2],
                values,
                candidateCount: valMap.size,
            });
        }
    }

    const deduplicatedCandidates = Array.from(map.values()).map(createValidatedFactCandidate);

    return {
        deduplicatedCandidates,
        warnings,
    };
}

module.exports = {
    buildCanonicalDeduplicationKey,
    deduplicateValidatedCandidates,
};
