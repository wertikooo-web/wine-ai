'use strict';

/**
 * WINE AI KOS - Evidence Validation & System Resolver Test Suite (Step 3B Refined Boundary)
 */

const assert = require('assert');
const { createEvidenceDraft, resolveSystemEvidence, createEvidenceSpan, verifyEvidenceSpan } = require('../src/kos/extraction/contracts/evidence');
const { createCandidateDraft } = require('../src/kos/extraction/contracts/factCandidate');
const { validateAndBuildFactCandidate, VALIDATION_ERROR_CODES } = require('../src/kos/extraction/validation/candidateValidator');

async function run() {
    let assertions = 0;
    const assertEqual = (a, b) => { assertions++; assert.strictEqual(a, b); };
    const assertOk = (cond) => { assertions++; assert.ok(cond); };

    const canonicalText = 'Винодельня Castel Mimi основана в 1893 году. Soiul Fetească Neagră — Țara Moldovei. 🍷 Moldovan Wine.';

    const mockDoc = {
        sourceId: 'src_doc_001',
        sourceChecksum: 'chk_123456',
        documentFingerprint: 'doc_fp_789',
        canonicalText,
        structuralUnits: [
            { id: 'docx_p_0001', docxLocation: { paragraphIndex: 1 } },
            { id: 'docx_p_0002', docxLocation: { paragraphIndex: 2 } },
        ],
    };

    // 1. Pure EvidenceDraft Creation (without source identity)
    const draftEvidence = createEvidenceDraft({
        evidenceType: 'label_value_pair',
        spans: [
            { quote: 'Castel Mimi', range: { representation: 'canonical-v1', utf16Start: 11, utf16End: 22, utf8ByteStart: Buffer.byteLength(canonicalText.slice(0, 11), 'utf8'), utf8ByteEnd: Buffer.byteLength(canonicalText.slice(0, 22), 'utf8') }, structuralUnitIds: ['docx_p_0001'] },
            { quote: '1893', range: { representation: 'canonical-v1', utf16Start: 34, utf16End: 38, utf8ByteStart: Buffer.byteLength(canonicalText.slice(0, 34), 'utf8'), utf8ByteEnd: Buffer.byteLength(canonicalText.slice(0, 38), 'utf8') }, structuralUnitIds: ['docx_p_0001'] },
        ],
    });

    assertOk(draftEvidence.sourceChecksum === undefined);
    assertOk(draftEvidence.documentFingerprint === undefined);

    // 2. System Evidence Resolution
    const resolvedEvidence = resolveSystemEvidence(draftEvidence, mockDoc);
    assertEqual(resolvedEvidence.sourceId, 'src_doc_001');
    assertEqual(resolvedEvidence.sourceChecksum, 'chk_123456');
    assertEqual(resolvedEvidence.documentFingerprint, 'doc_fp_789');
    assertEqual(resolvedEvidence.spans[0].formatLocations[0].format, 'docx');
    assertEqual(resolvedEvidence.spans[0].formatLocations[0].paragraphIndex, 1);

    for (const span of resolvedEvidence.spans) {
        const valRes = verifyEvidenceSpan(canonicalText, span);
        assertOk(valRes.isValid);
    }

    // 3. UTF-8 Offset Verification Failure Test
    const badUtf8Span = createEvidenceSpan({
        quote: 'Castel Mimi',
        range: { representation: 'canonical-v1', utf16Start: 11, utf16End: 22, utf8ByteStart: 0, utf8ByteEnd: 5 },
    });
    const utf8Val = verifyEvidenceSpan(canonicalText, badUtf8Span);
    assertEqual(utf8Val.isValid, false);
    assertEqual(utf8Val.code, 'KOS_FACT_UTF8_RANGE_INVALID');

    // 4. Surrogate Pair Split Rejection Test (Emoji 🍷)
    const emojiIndex = canonicalText.indexOf('🍷');
    assertOk(emojiIndex > 0);
    const splitSurrogateSpan = createEvidenceSpan({
        quote: 'Invalid',
        range: { representation: 'canonical-v1', utf16Start: emojiIndex + 1, utf16End: emojiIndex + 2 },
    });
    const surrVal = verifyEvidenceSpan(canonicalText, splitSurrogateSpan);
    assertEqual(surrVal.isValid, false);
    assertEqual(surrVal.code, 'KOS_FACT_SURROGATE_PAIR_SPLIT');

    // 5. Draft Validation with Valid Multi-Span Evidence
    const candidateDraft = createCandidateDraft({
        entityType: 'winery',
        fieldPath: 'winery.brandName',
        rawValue: 'Castel Mimi',
        valueType: 'string',
        evidenceDrafts: [draftEvidence],
    });

    const validatedCandidate = validateAndBuildFactCandidate(candidateDraft, mockDoc);
    assertEqual(validatedCandidate.validationStatus, 'valid');
    assertEqual(validatedCandidate.validation.isValid, true);
    assertEqual(validatedCandidate.evidence[0].sourceChecksum, 'chk_123456');

    console.log(`kosEvidenceValidation.test.js: All ${assertions} assertions passed successfully!`);
    return { assertionCount: assertions };
}

module.exports = { run };
