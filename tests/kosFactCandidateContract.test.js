'use strict';

/**
 * WINE AI KOS - Fact Candidate & Review Contract Test Suite (Step 3B Refined Boundary)
 */

const assert = require('assert');
const {
    createCandidateDraft,
    createValidatedFactCandidate,
    createCandidateReview,
    VALIDATION_STATUS,
    REVIEW_DECISION,
} = require('../src/kos/extraction/contracts/factCandidate');

async function run() {
    let assertions = 0;
    const assertEqual = (a, b) => { assertions++; assert.strictEqual(a, b); };
    const assertOk = (cond) => { assertions++; assert.ok(cond); };

    // 1. Create CandidateDraft (Pure draft without source identity or status)
    const draft = createCandidateDraft({
        entityType: 'wine',
        fieldPath: 'wine.name',
        rawValue: 'Governor 2019',
        valueType: 'string',
        entityRef: { kind: 'provisional', provisionalKey: 'governor-2019', displayName: 'Governor 2019' },
    });

    assertEqual(draft.entityType, 'wine');
    assertEqual(draft.fieldPath, 'wine.name');
    assertEqual(draft.entityRef.provisionalKey, 'governor-2019');
    assertOk(draft.sourceChecksum === undefined);
    assertOk(draft.documentFingerprint === undefined);
    assertOk(draft.candidateId === undefined);
    assertOk(draft.validationStatus === undefined);

    // 2. Deep Freeze Immutability Assertion
    assertions++;
    assert.throws(() => {
        draft.entityRef.displayName = 'Hacked';
    }, TypeError);

    // 3. Create ValidatedFactCandidate (Status is VALID/INVALID, no approved/rejected!)
    const candidate = createValidatedFactCandidate({
        candidateId: 'cand_123456',
        entityType: 'wine',
        entityRef: draft.entityRef,
        fieldPath: 'wine.name',
        value: 'Governor 2019',
        normalizedValue: 'Governor 2019',
        valueType: 'string',
        validation: { isValid: true },
    });

    assertEqual(candidate.candidateId, 'cand_123456');
    assertEqual(candidate.validationStatus, VALIDATION_STATUS.VALID);
    assertOk(candidate.status === undefined);

    // 4. Deep Freeze Immutability Assertion on Validated Candidate
    assertions++;
    assert.throws(() => {
        candidate.validation.isValid = false;
    }, TypeError);

    // 5. Create CandidateReview Decision (Separate Review Record)
    const review = createCandidateReview({
        reviewId: 'rev_789',
        candidateId: 'cand_123456',
        decision: REVIEW_DECISION.APPROVED,
        reviewer: 'sommelier_john',
        comment: 'Verified with tech sheet.',
    });

    assertEqual(review.reviewId, 'rev_789');
    assertEqual(review.candidateId, 'cand_123456');
    assertEqual(review.decision, REVIEW_DECISION.APPROVED);

    console.log(`kosFactCandidateContract.test.js: All ${assertions} assertions passed successfully!`);
    return { assertionCount: assertions };
}

module.exports = { run };
