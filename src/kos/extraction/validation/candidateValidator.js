'use strict';

/**
 * WINE AI KOS - Fact Candidate Validator (Step 3B Refined Boundary)
 *
 * System validation layer that transforms CandidateDraft into ValidatedFactCandidate.
 * Computes Candidate ID, normalizes values, resolves system evidence & format locations, and enforces factor sum checks.
 */

const { getFieldPolicy } = require('../policies/extractionFieldPolicies');
const { resolveSystemEvidence, verifyEvidenceSpan } = require('../contracts/evidence');
const { createValidatedFactCandidate, VALUE_TYPES, CONFIDENCE_METHODS } = require('../contracts/factCandidate');
const { generateCandidateId } = require('../identity/candidateFingerprint');
const {
    normalizeString,
    normalizeDecimal,
    normalizeInteger,
    normalizeBoolean,
    normalizePercentage,
    normalizeYear,
    normalizeVolume,
    normalizeMoney,
    normalizeUrl,
    normalizeEmail,
    normalizePhone,
    normalizeLanguageTag,
} = require('../normalization/valueNormalizers');

const VALIDATION_ERROR_CODES = Object.freeze({
    KOS_FACT_FIELD_UNKNOWN: 'KOS_FACT_FIELD_UNKNOWN',
    KOS_FACT_ENTITY_TYPE_MISMATCH: 'KOS_FACT_ENTITY_TYPE_MISMATCH',
    KOS_FACT_VALUE_TYPE_INVALID: 'KOS_FACT_VALUE_TYPE_INVALID',
    KOS_FACT_VALUE_OUT_OF_RANGE: 'KOS_FACT_VALUE_OUT_OF_RANGE',
    KOS_FACT_EVIDENCE_MISSING: 'KOS_FACT_EVIDENCE_MISSING',
    KOS_FACT_EVIDENCE_RANGE_INVALID: 'KOS_FACT_EVIDENCE_RANGE_INVALID',
    KOS_FACT_QUOTE_MISMATCH: 'KOS_FACT_QUOTE_MISMATCH',
    KOS_FACT_STRUCTURAL_UNIT_NOT_FOUND: 'KOS_FACT_STRUCTURAL_UNIT_NOT_FOUND',
    KOS_FACT_SOURCE_MISMATCH: 'KOS_FACT_SOURCE_MISMATCH',
    KOS_FACT_NORMALIZATION_FAILED: 'KOS_FACT_NORMALIZATION_FAILED',
    KOS_FACT_LANGUAGE_INVALID: 'KOS_FACT_LANGUAGE_INVALID',
    KOS_FACT_UNIT_INVALID: 'KOS_FACT_UNIT_INVALID',
    KOS_FACT_CARDINALITY_INVALID: 'KOS_FACT_CARDINALITY_INVALID',
    KOS_FACT_CONFIDENCE_INVALID: 'KOS_FACT_CONFIDENCE_INVALID',
    KOS_FACT_EXTRACTION_METHOD_INVALID: 'KOS_FACT_EXTRACTION_METHOD_INVALID',
    KOS_FACT_ENTITY_REFERENCE_INVALID: 'KOS_FACT_ENTITY_REFERENCE_INVALID',
    KOS_FACT_VALUE_TOO_LONG: 'KOS_FACT_VALUE_TOO_LONG',
    KOS_FACT_ENUM_VALUE_INVALID: 'KOS_FACT_ENUM_VALUE_INVALID',
    KOS_FACT_UTF8_RANGE_INVALID: 'KOS_FACT_UTF8_RANGE_INVALID',
    KOS_FACT_FORMAT_LOCATION_MISMATCH: 'KOS_FACT_FORMAT_LOCATION_MISMATCH',
    KOS_FACT_SURROGATE_PAIR_SPLIT: 'KOS_FACT_SURROGATE_PAIR_SPLIT',
});

function normalizeCandidateValue(value, valueType, policy) {
    if (value === undefined || value === null) return null;

    switch (valueType) {
        case 'string':
        case 'localized_string':
            return normalizeString(value);
        case 'integer':
            return policy && policy.unit === 'ml' ? normalizeVolume(value) : normalizeInteger(value);
        case 'decimal':
            return policy && policy.unit === 'percent_abv' ? normalizePercentage(value) : normalizeDecimal(value);
        case 'boolean':
            return normalizeBoolean(value);
        case 'year':
            return normalizeYear(value);
        case 'measurement':
            return normalizeVolume(value);
        case 'money':
            return normalizeMoney(value);
        case 'url':
            return normalizeUrl(value);
        case 'email':
            return normalizeEmail(value);
        case 'phone':
            return normalizePhone(value);
        default:
            return normalizeString(value);
    }
}

function validateAndBuildFactCandidate(candidateDraft, parsedDocument = null, customPolicies = null, options = {}) {
    const errors = [];
    const warnings = [];

    if (!candidateDraft) {
        throw new Error('validateAndBuildFactCandidate requires a valid CandidateDraft object.');
    }

    const policy = customPolicies ? customPolicies[candidateDraft.fieldPath] : getFieldPolicy(candidateDraft.fieldPath);

    // 1. Policy & Value Type Checks
    if (!policy) {
        errors.push({
            code: VALIDATION_ERROR_CODES.KOS_FACT_FIELD_UNKNOWN,
            message: `Unknown fieldPath "${candidateDraft.fieldPath}". No policy registered.`,
            fieldPath: candidateDraft.fieldPath,
        });
    } else {
        if (candidateDraft.entityType !== policy.entityType) {
            errors.push({
                code: VALIDATION_ERROR_CODES.KOS_FACT_ENTITY_TYPE_MISMATCH,
                message: `Candidate entityType "${candidateDraft.entityType}" conflicts with policy "${policy.entityType}".`,
                expected: policy.entityType,
                actual: candidateDraft.entityType,
            });
        }

        if (candidateDraft.valueType !== policy.valueType) {
            errors.push({
                code: VALIDATION_ERROR_CODES.KOS_FACT_VALUE_TYPE_INVALID,
                message: `Candidate valueType "${candidateDraft.valueType}" conflicts with policy "${policy.valueType}".`,
                expected: policy.valueType,
                actual: candidateDraft.valueType,
            });
        }
    }

    // 2. System Value Normalization
    let normalizedValue = null;
    try {
        normalizedValue = normalizeCandidateValue(candidateDraft.rawValue, candidateDraft.valueType, policy);
        if (candidateDraft.rawValue !== null && candidateDraft.rawValue !== undefined && normalizedValue === null) {
            errors.push({
                code: VALIDATION_ERROR_CODES.KOS_FACT_NORMALIZATION_FAILED,
                message: `Failed to normalize value "${candidateDraft.rawValue}" for type "${candidateDraft.valueType}".`,
            });
        }
    } catch (err) {
        errors.push({
            code: VALIDATION_ERROR_CODES.KOS_FACT_NORMALIZATION_FAILED,
            message: `Normalization threw exception: ${err.message}`,
        });
    }

    // 3. Range Constraints & Maximum Length
    if (policy && typeof normalizedValue === 'number') {
        if (policy.minimum !== undefined && normalizedValue < policy.minimum) {
            errors.push({
                code: VALIDATION_ERROR_CODES.KOS_FACT_VALUE_OUT_OF_RANGE,
                message: `Value ${normalizedValue} is below minimum allowed ${policy.minimum}.`,
            });
        }
        if (policy.maximum !== undefined && normalizedValue > policy.maximum) {
            errors.push({
                code: VALIDATION_ERROR_CODES.KOS_FACT_VALUE_OUT_OF_RANGE,
                message: `Value ${normalizedValue} exceeds maximum allowed ${policy.maximum}.`,
            });
        }
    }

    if (policy && policy.maxLength && typeof normalizedValue === 'string' && normalizedValue.length > policy.maxLength) {
        errors.push({
            code: VALIDATION_ERROR_CODES.KOS_FACT_VALUE_TOO_LONG,
            message: `Value length (${normalizedValue.length}) exceeds policy maxLength (${policy.maxLength}).`,
        });
    }

    // 4. Confidence Score & Factor Sum Validation
    const confidence = candidateDraft.confidence;
    const confidenceScore = confidence?.score;
    if (typeof confidenceScore !== 'number' || !Number.isFinite(confidenceScore) || confidenceScore < 0 || confidenceScore > 1) {
        errors.push({
            code: VALIDATION_ERROR_CODES.KOS_FACT_CONFIDENCE_INVALID,
            message: `Confidence score must be a finite number between 0 and 1. Received: ${confidenceScore}`,
        });
    } else if (Array.isArray(confidence?.factors) && confidence.factors.length > 0) {
        const factorSum = confidence.factors.reduce((acc, f) => acc + (Number(f.contribution) || 0), 0);
        if (Math.abs(factorSum - confidenceScore) > 1e-6) {
            errors.push({
                code: VALIDATION_ERROR_CODES.KOS_FACT_CONFIDENCE_INVALID,
                message: `Confidence factor contributions sum (${factorSum}) does not equal score (${confidenceScore}).`,
            });
        }
    }

    // 5. System Evidence Resolution & Verification
    const rawEvidenceDrafts = Array.isArray(candidateDraft.evidenceDrafts) ? candidateDraft.evidenceDrafts : [];
    const verifiedEvidenceList = [];

    if (policy && policy.evidenceRequired && rawEvidenceDrafts.length === 0) {
        errors.push({
            code: VALIDATION_ERROR_CODES.KOS_FACT_EVIDENCE_MISSING,
            message: `Field "${candidateDraft.fieldPath}" requires evidence bindings, but evidence is empty.`,
        });
    }

    const canonicalText = parsedDocument ? parsedDocument.canonicalText : null;
    const validUnitMap = new Map((parsedDocument?.structuralUnits || []).map((u) => [u.id, u]));

    for (let i = 0; i < rawEvidenceDrafts.length; i++) {
        let ev;
        try {
            ev = resolveSystemEvidence(rawEvidenceDrafts[i], parsedDocument);
        } catch (err) {
            errors.push({
                code: VALIDATION_ERROR_CODES.KOS_FACT_EVIDENCE_RANGE_INVALID,
                message: `Evidence resolution failed: ${err.message}`,
            });
            continue;
        }

        if (parsedDocument) {
            for (const span of ev.spans) {
                const spanVal = verifyEvidenceSpan(canonicalText, span);
                if (!spanVal.isValid) {
                    errors.push({
                        code: VALIDATION_ERROR_CODES[spanVal.code] || VALIDATION_ERROR_CODES.KOS_FACT_QUOTE_MISMATCH,
                        message: `Evidence span quote verification failed: ${spanVal.code}`,
                        expectedQuote: spanVal.expectedQuote,
                        actualQuote: spanVal.actualQuote,
                    });
                }

                for (const unitId of span.structuralUnitIds) {
                    const unit = validUnitMap.get(unitId);
                    if (!unit) {
                        errors.push({
                            code: VALIDATION_ERROR_CODES.KOS_FACT_STRUCTURAL_UNIT_NOT_FOUND,
                            message: `Structural unit ID "${unitId}" not found in ParsedDocument.`,
                            unitId,
                        });
                    }
                }
            }
        }

        verifiedEvidenceList.push(ev);
    }

    const isValid = errors.length === 0;

    // 6. Calculate System Deterministic Candidate ID
    const candidateId = generateCandidateId({
        sourceChecksum: parsedDocument?.sourceChecksum || '',
        documentFingerprint: parsedDocument?.documentFingerprint || '',
        entityType: candidateDraft.entityType,
        entityRef: candidateDraft.entityRef,
        fieldPath: candidateDraft.fieldPath,
        valueType: candidateDraft.valueType,
        normalizedValue,
        evidence: verifiedEvidenceList,
        extractor: candidateDraft.extractor,
    });

    const nowIso = options.now ? options.now().toISOString() : new Date().toISOString();

    return createValidatedFactCandidate({
        candidateId,
        entityType: candidateDraft.entityType,
        entityRef: candidateDraft.entityRef,
        fieldPath: candidateDraft.fieldPath,
        rawValue: candidateDraft.rawValue,
        normalizedValue,
        valueType: candidateDraft.valueType,
        unit: policy?.unit || candidateDraft.unit || null,
        language: candidateDraft.language || null,
        evidence: verifiedEvidenceList,
        confidence: candidateDraft.confidence,
        extractor: candidateDraft.extractor,
        validation: {
            isValid,
            errors,
            warnings,
        },
        createdAt: nowIso,
    });
}

module.exports = {
    VALIDATION_ERROR_CODES,
    validateAndBuildFactCandidate,
};
