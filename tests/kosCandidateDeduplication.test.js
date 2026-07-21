'use strict';

/**
 * WINE AI KOS - Post-Validation Deduplication Test Suite (Step 3B Production)
 */

const assert = require('assert');
const { deduplicateValidatedCandidates, buildCanonicalDeduplicationKey } = require('../src/kos/extraction/deterministic/candidateDeduplicator');
const { createCandidateDraft, createValidatedFactCandidate } = require('../src/kos/extraction/contracts/factCandidate');
const { resolveSystemEvidence } = require('../src/kos/extraction/contracts/evidence');

async function run() {
    let assertions = 0;
    const assertEqual = (a, b) => { assertions++; assert.strictEqual(a, b); };
    const assertOk = (cond) => { assertions++; assert.ok(cond); };

    const mockDoc = {
        sourceId: 'src_1',
        sourceChecksum: 'chk_100',
        documentFingerprint: 'doc_fp_200',
    };

    const ev1 = resolveSystemEvidence({
        evidenceType: 'label_value_pair',
        spans: [
            { quote: 'Alcool:', range: { utf16Start: 0, utf16End: 7 } },
            { quote: '13,5%', range: { utf16Start: 8, utf16End: 13 } },
        ],
    }, mockDoc);

    const ev2 = resolveSystemEvidence({
        evidenceType: 'label_value_pair',
        spans: [
            { quote: 'Alcohol:', range: { utf16Start: 50, utf16End: 58 } },
            { quote: '13.5% abv', range: { utf16Start: 59, utf16End: 68 } },
        ],
    }, mockDoc);

    // Two candidates with different raw text ('13,5%' vs '13.5% abv') but IDENTICAL normalizedValue (13.5)
    const cand1 = createValidatedFactCandidate({
        candidateId: 'cand_1',
        entityType: 'wine',
        entityRef: { kind: 'provisional', provisionalKey: 'governor-2019' },
        fieldPath: 'wine.alcoholPercent',
        value: '13,5%',
        normalizedValue: 13.5,
        valueType: 'decimal',
        evidence: [ev1],
        confidence: { score: 0.95 },
        extractor: { name: 'kos-label-value-extractor', version: '1.0.0' },
        validation: { isValid: true },
    });

    const cand2 = createValidatedFactCandidate({
        candidateId: 'cand_2',
        entityType: 'wine',
        entityRef: { kind: 'provisional', provisionalKey: 'governor-2019' },
        fieldPath: 'wine.alcoholPercent',
        value: '13.5% abv',
        normalizedValue: 13.5, // Identical normalized value!
        valueType: 'decimal',
        evidence: [ev2],
        confidence: { score: 0.95 },
        extractor: { name: 'kos-label-value-extractor', version: '1.0.0' },
        validation: { isValid: true },
    });

    // Conflicting candidate with DIFFERENT normalizedValue (14.0)
    const candConflict = createValidatedFactCandidate({
        candidateId: 'cand_3',
        entityType: 'wine',
        entityRef: { kind: 'provisional', provisionalKey: 'governor-2019' },
        fieldPath: 'wine.alcoholPercent',
        value: '14,0%',
        normalizedValue: 14.0, // Different normalized value!
        valueType: 'decimal',
        evidence: [ev1],
        confidence: { score: 0.90 },
        extractor: { name: 'kos-label-value-extractor', version: '1.0.0' },
        validation: { isValid: true },
    });

    const { deduplicatedCandidates, warnings } = deduplicateValidatedCandidates([cand1, cand2, candConflict]);

    // 1. Identical normalized values merged into 1 candidate with multi-span evidence
    assertEqual(deduplicatedCandidates.length, 2);

    const mergedCand = deduplicatedCandidates.find((c) => c.normalizedValue === 13.5);
    assertOk(mergedCand);
    assertEqual(mergedCand.evidence.length, 2);

    // 2. Structured KOS_EXTRACTION_CONFLICTING_VALUES Warning Generated
    assertEqual(warnings.length, 1);
    assertEqual(warnings[0].code, 'KOS_EXTRACTION_CONFLICTING_VALUES');
    assertEqual(warnings[0].fieldPath, 'wine.alcoholPercent');
    assertOk(warnings[0].values.includes(13.5));
    assertOk(warnings[0].values.includes(14.0));

    console.log(`kosCandidateDeduplication.test.js: All ${assertions} assertions passed successfully!`);
    return { assertionCount: assertions };
}

module.exports = { run };
