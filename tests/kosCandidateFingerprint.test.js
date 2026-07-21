'use strict';

/**
 * WINE AI KOS - Candidate Fingerprint Test Suite (Step 3A Refined)
 */

const assert = require('assert');
const { generateCandidateId, canonicalJsonStringify } = require('../src/kos/extraction/identity/candidateFingerprint');

async function run() {
    let assertions = 0;
    const assertEqual = (a, b) => { assertions++; assert.strictEqual(a, b); };
    const assertOk = (cond) => { assertions++; assert.ok(cond); };

    // 1. Canonical JSON Key Sorting & Object Serialization
    const uncanonicalObj = { z: 1, a: 2, m: { b: 3, a: 4 } };
    const jsonStr = canonicalJsonStringify(uncanonicalObj);
    assertEqual(jsonStr, '{"a":2,"m":{"a":4,"b":3},"z":1}');

    // 2. Rejection of NaN, Infinity, and undefined
    assertions++;
    assert.throws(() => {
        canonicalJsonStringify({ val: NaN });
    }, TypeError);

    assertions++;
    assert.throws(() => {
        canonicalJsonStringify({ val: Infinity });
    }, TypeError);

    // 3. Stable Candidate ID Calculation
    const payloadA = {
        sourceChecksum: 'chk_123',
        documentFingerprint: 'doc_fp_456',
        entityType: 'wine',
        entityRef: { kind: 'provisional', provisionalKey: 'governor-2019', displayName: 'Governor 2019' },
        fieldPath: 'wine.name',
        valueType: 'string',
        normalizedValue: 'Governor 2019',
        evidence: [
            { sourceId: 'src_1', sourceChecksum: 'chk_123', documentFingerprint: 'doc_fp_456', spans: [{ quote: 'Governor', range: { utf16Start: 10, utf16End: 18 } }] },
            { sourceId: 'src_1', sourceChecksum: 'chk_123', documentFingerprint: 'doc_fp_456', spans: [{ quote: '2019', range: { utf16Start: 19, utf16End: 23 } }] },
        ],
        extractor: { name: 'kos-wine-extractor', version: '1.0.0' },
    };

    // Reordered evidence array
    const payloadB = {
        ...payloadA,
        evidence: [
            payloadA.evidence[1],
            payloadA.evidence[0],
        ],
    };

    const idA = generateCandidateId(payloadA);
    const idB = generateCandidateId(payloadB);

    assertEqual(idA.length, 64);
    assertEqual(idA, idB); // Order independence check

    // 4. Verification that createdAt does NOT affect Candidate ID
    const payloadWithTime1 = { ...payloadA, createdAt: '2026-01-01T00:00:00.000Z' };
    const payloadWithTime2 = { ...payloadA, createdAt: '2026-12-31T23:59:59.999Z' };
    assertEqual(generateCandidateId(payloadWithTime1), generateCandidateId(payloadWithTime2));

    // 5. Verification that different normalized values produce different Candidate IDs
    const payloadDifferentValue = { ...payloadA, normalizedValue: 'Governor 2020' };
    assertOk(generateCandidateId(payloadA) !== generateCandidateId(payloadDifferentValue));

    // 6. Known vs Provisional Entity Canonicalization
    const knownEntityCandidate = generateCandidateId({ ...payloadA, entityRef: { kind: 'known', id: 'wine_id_999' } });
    const provisionalEntityCandidate = generateCandidateId({ ...payloadA, entityRef: { kind: 'provisional', provisionalKey: 'governor-2019' } });
    assertOk(knownEntityCandidate !== provisionalEntityCandidate);

    console.log(`kosCandidateFingerprint.test.js: All ${assertions} assertions passed successfully!`);
    return { assertionCount: assertions };
}

module.exports = { run };
