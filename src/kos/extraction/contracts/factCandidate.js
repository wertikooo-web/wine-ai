'use strict';

/**
 * WINE AI KOS - Fact Candidate & Review Contracts (Step 3B Refined Boundary)
 *
 * CandidateDraft excludes sourceChecksum, documentFingerprint, sourceId, candidateId, normalizedValue, or status.
 * System Validator computes system fields and constructs ValidatedFactCandidate.
 */

const { deepFreeze } = require('../helpers/deepFreeze');
const { createEvidenceDraft } = require('./evidence');

const CANDIDATE_SCHEMA_VERSION = '1.0.0';

const VALIDATION_STATUS = Object.freeze({
    VALID: 'valid',
    INVALID: 'invalid',
});

const REVIEW_DECISION = Object.freeze({
    APPROVED: 'approved',
    REJECTED: 'rejected',
    NEEDS_CHANGES: 'needs_changes',
});

const VALUE_TYPES = Object.freeze([
    'string',
    'localized_string',
    'integer',
    'decimal',
    'boolean',
    'date',
    'year',
    'enum',
    'measurement',
    'money',
    'url',
    'phone',
    'email',
    'entity_reference',
    'string_list',
]);

const CONFIDENCE_METHODS = Object.freeze([
    'deterministic_exact_match',
    'deterministic_pattern',
    'deterministic_table_mapping',
    'model_extraction',
    'human_entered',
]);

function canonicalizeEntityRef(entityRef = {}) {
    if (entityRef.kind === 'known') {
        if (!entityRef.id) throw new Error('Known entityRef requires a non-empty id.');
        return deepFreeze({
            kind: 'known',
            id: String(entityRef.id),
        });
    }

    const provisionalKey = String(entityRef.provisionalKey || entityRef.displayName || 'provisional-entity')
        .normalize('NFC')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    const displayName = String(entityRef.displayName || entityRef.provisionalKey || 'Provisional Entity').normalize('NFC').trim();

    return deepFreeze({
        kind: 'provisional',
        id: null,
        provisionalKey: provisionalKey || 'provisional-entity',
        displayName,
    });
}

function createCandidateDraft(data = {}) {
    if (!data.entityType || typeof data.entityType !== 'string') {
        throw new Error('CandidateDraft requires a valid entityType string.');
    }
    if (!data.fieldPath || typeof data.fieldPath !== 'string') {
        throw new Error('CandidateDraft requires a valid fieldPath string.');
    }

    const valueType = VALUE_TYPES.includes(data.valueType) ? data.valueType : 'string';

    const confidence = {
        score: typeof data.confidence?.score === 'number' ? Math.max(0, Math.min(1, data.confidence.score)) : 0.0,
        method: CONFIDENCE_METHODS.includes(data.confidence?.method) ? data.confidence.method : 'deterministic_exact_match',
        factors: Array.isArray(data.confidence?.factors)
            ? data.confidence.factors
                .filter((f) => f && typeof f.code === 'string' && Number.isFinite(f.contribution))
                .map((f) => ({ code: f.code, contribution: f.contribution }))
            : [],
    };

    const extractor = {
        name: String(data.extractor?.name || 'kos-unknown-extractor'),
        version: String(data.extractor?.version || '1.0.0'),
    };

    const rawEvidenceDrafts = Array.isArray(data.evidenceDrafts) ? data.evidenceDrafts : (Array.isArray(data.evidence) ? data.evidence : []);
    const evidenceDrafts = rawEvidenceDrafts.map(createEvidenceDraft);

    return deepFreeze({
        entityType: data.entityType,
        entityRef: canonicalizeEntityRef(data.entityRef),
        fieldPath: data.fieldPath,
        rawValue: data.rawValue !== undefined ? data.rawValue : (data.value !== undefined ? data.value : null),
        valueType,
        unit: data.unit ? String(data.unit) : null,
        language: data.language ? String(data.language) : null,
        evidenceDrafts,
        confidence,
        extractor,
    });
}

function createValidatedFactCandidate(data = {}) {
    if (!data.candidateId || typeof data.candidateId !== 'string') {
        throw new Error('ValidatedFactCandidate requires a system-calculated candidateId.');
    }

    const isValid = Boolean(data.validation?.isValid);
    const validationStatus = isValid ? VALIDATION_STATUS.VALID : VALIDATION_STATUS.INVALID;

    return deepFreeze({
        schemaVersion: CANDIDATE_SCHEMA_VERSION,
        candidateId: data.candidateId,
        entityType: data.entityType,
        entityRef: canonicalizeEntityRef(data.entityRef),
        fieldPath: data.fieldPath,
        value: data.rawValue !== undefined ? data.rawValue : data.value,
        normalizedValue: data.normalizedValue !== undefined ? data.normalizedValue : null,
        valueType: data.valueType,
        unit: data.unit || null,
        language: data.language || null,
        evidence: Array.isArray(data.evidence) ? [...data.evidence] : [],
        confidence: deepFreeze(data.confidence),
        extractor: deepFreeze(data.extractor),
        relationshipToExisting: deepFreeze(data.relationshipToExisting || { type: 'unknown', existingFactIds: [] }),
        validationStatus,
        validation: deepFreeze({
            isValid,
            errors: Array.isArray(data.validation?.errors) ? [...data.validation.errors] : [],
            warnings: Array.isArray(data.validation?.warnings) ? [...data.validation.warnings] : [],
        }),
        createdAt: data.createdAt || new Date().toISOString(),
    });
}

function createCandidateReview(data = {}) {
    if (!data.reviewId || typeof data.reviewId !== 'string') {
        throw new Error('CandidateReview requires a valid reviewId.');
    }
    if (!data.candidateId || typeof data.candidateId !== 'string') {
        throw new Error('CandidateReview requires a valid candidateId.');
    }
    if (!Object.values(REVIEW_DECISION).includes(data.decision)) {
        throw new Error(`Invalid review decision: ${data.decision}`);
    }

    return deepFreeze({
        reviewId: data.reviewId,
        candidateId: data.candidateId,
        decision: data.decision,
        reviewer: String(data.reviewer || 'system_reviewer'),
        reasonCodes: Array.isArray(data.reasonCodes) ? [...data.reasonCodes] : [],
        comment: data.comment ? String(data.comment) : null,
        reviewedAt: data.reviewedAt || new Date().toISOString(),
    });
}

module.exports = {
    CANDIDATE_SCHEMA_VERSION,
    VALIDATION_STATUS,
    REVIEW_DECISION,
    VALUE_TYPES,
    CONFIDENCE_METHODS,
    canonicalizeEntityRef,
    createCandidateDraft,
    createValidatedFactCandidate,
    createCandidateReview,
};
