'use strict';

/**
 * WINE AI KOS - Extraction Result Envelope Test Suite (Step 3A Refined)
 */

const assert = require('assert');
const { buildExtractionResult } = require('../src/kos/extraction/contracts/extractionResult');
const { createCandidateDraft } = require('../src/kos/extraction/contracts/factCandidate');

async function run() {
    let assertions = 0;
    const assertEqual = (a, b) => { assertions++; assert.strictEqual(a, b); };
    const assertOk = (cond) => { assertions++; assert.ok(cond); };

    const canonicalText = 'Castel Mimi Governor 2019 Fetească Neagră.';
    const mockDoc = {
        sourceChecksum: 'chk_100',
        documentFingerprint: 'doc_fp_200',
        canonicalText,
        structuralUnits: [{ id: 'p_1' }],
    };

    // 1 Valid Draft + 1 Invalid Draft
    const validDraft = createCandidateDraft({
        entityType: 'winery',
        fieldPath: 'winery.brandName',
        rawValue: 'Castel Mimi',
        valueType: 'string',
        evidenceDrafts: [{
            sourceId: 'src_1',
            sourceChecksum: 'chk_100',
            documentFingerprint: 'doc_fp_200',
            spans: [{ quote: 'Castel Mimi', range: { representation: 'canonical-v1', utf16Start: 0, utf16End: 11 }, structuralUnitIds: ['p_1'] }],
        }],
    });

    const invalidDraft = createCandidateDraft({
        entityType: 'wine',
        fieldPath: 'wine.alcoholPercent',
        rawValue: '99.0 %', // Invalid: exceeds 30% ABV
        valueType: 'decimal',
    });

    const resultEnvelope = buildExtractionResult({
        runId: 'run_test_001',
        parsedDocument: mockDoc,
        extractor: { name: 'kos-test-extractor', version: '1.0.0' },
        drafts: [validDraft, invalidDraft],
        timing: { startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z', durationMs: 1000 },
    });

    assertEqual(resultEnvelope.schemaVersion, '1.0.0');
    assertEqual(resultEnvelope.extractionRunId, 'run_test_001');
    assertEqual(resultEnvelope.candidates.length, 2);

    // System Calculated Metrics Verification
    assertEqual(resultEnvelope.metrics.candidatesProduced, 2);
    assertEqual(resultEnvelope.metrics.validCandidates, 1);
    assertEqual(resultEnvelope.metrics.invalidCandidates, 1);
    assertEqual(resultEnvelope.metrics.evidenceRangesChecked, 1);
    assertEqual(resultEnvelope.metrics.durationMs, 1000);

    // Verify candidates inside envelope carry validationStatus (valid vs invalid)
    assertEqual(resultEnvelope.candidates[0].validationStatus, 'valid');
    assertEqual(resultEnvelope.candidates[1].validationStatus, 'invalid');

    console.log(`kosExtractionResult.test.js: All ${assertions} assertions passed successfully!`);
    return { assertionCount: assertions };
}

module.exports = { run };
