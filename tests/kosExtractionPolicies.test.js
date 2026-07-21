'use strict';

/**
 * WINE AI KOS - Extraction Field Policies Test Suite (Step 3A Refined)
 */

const assert = require('assert');
const { getFieldPolicy } = require('../src/kos/extraction/policies/extractionFieldPolicies');
const { createCandidateDraft } = require('../src/kos/extraction/contracts/factCandidate');
const { validateAndBuildFactCandidate, VALIDATION_ERROR_CODES } = require('../src/kos/extraction/validation/candidateValidator');

async function run() {
    let assertions = 0;
    const assertEqual = (a, b) => { assertions++; assert.strictEqual(a, b); };
    const assertOk = (cond) => { assertions++; assert.ok(cond); };

    // 1. Policy Lookup & Structural Property Checks
    const alcoholPolicy = getFieldPolicy('wine.alcoholPercent');
    assertOk(alcoholPolicy);
    assertEqual(alcoholPolicy.entityType, 'wine');
    assertEqual(alcoholPolicy.valueType, 'decimal');
    assertEqual(alcoholPolicy.unit, 'percent_abv');
    assertEqual(alcoholPolicy.cardinality, 'single');
    assertEqual(alcoholPolicy.minimum, 0.0);
    assertEqual(alcoholPolicy.maximum, 30.0);

    // 2. Out-of-Range Alcohol Percentage Validation Error
    const invalidAlcDraft = createCandidateDraft({
        entityType: 'wine',
        fieldPath: 'wine.alcoholPercent',
        rawValue: '45.0 %', // Invalid: exceeds 30% ABV limit
        valueType: 'decimal',
        evidenceDrafts: [{ sourceId: 'src_1', quote: '45%', range: { utf16Start: 0, utf16End: 3 } }],
    });

    const alcVal = validateAndBuildFactCandidate(invalidAlcDraft);
    assertEqual(alcVal.validationStatus, 'invalid');
    assertEqual(alcVal.validation.isValid, false);
    assertOk(alcVal.validation.errors.some((e) => e.code === VALIDATION_ERROR_CODES.KOS_FACT_VALUE_OUT_OF_RANGE));

    // 3. Unknown fieldPath Error
    const unknownDraft = createCandidateDraft({
        entityType: 'wine',
        fieldPath: 'wine.nonExistentField',
        rawValue: 'Test',
        valueType: 'string',
    });

    const unknownVal = validateAndBuildFactCandidate(unknownDraft);
    assertEqual(unknownVal.validationStatus, 'invalid');
    assertOk(unknownVal.validation.errors.some((e) => e.code === VALIDATION_ERROR_CODES.KOS_FACT_FIELD_UNKNOWN));

    // 4. Entity Type Mismatch Error
    const mismatchEntityDraft = createCandidateDraft({
        entityType: 'winery', // Expected 'wine' for wine.vintageYear
        fieldPath: 'wine.vintageYear',
        rawValue: '2019',
        valueType: 'year',
    });

    const mismatchVal = validateAndBuildFactCandidate(mismatchEntityDraft);
    assertEqual(mismatchVal.validationStatus, 'invalid');
    assertOk(mismatchVal.validation.errors.some((e) => e.code === VALIDATION_ERROR_CODES.KOS_FACT_ENTITY_TYPE_MISMATCH));

    console.log(`kosExtractionPolicies.test.js: All ${assertions} assertions passed successfully!`);
    return { assertionCount: assertions };
}

module.exports = { run };
