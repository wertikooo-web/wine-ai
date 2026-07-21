'use strict';

/**
 * WINE AI KOS - Extraction Result Envelope & System Metrics (Step 3A Refined)
 *
 * Constructs the extraction result envelope and calculates metrics strictly from system validation results.
 */

const { deepFreeze } = require('../helpers/deepFreeze');
const { validateAndBuildFactCandidate } = require('../validation/candidateValidator');

const EXTRACTION_RESULT_SCHEMA_VERSION = '1.0.0';

function buildExtractionResult({ runId, parsedDocument, extractor, drafts = [], timing = {}, options = {} }) {
    if (!parsedDocument) {
        throw new Error('buildExtractionResult requires a ParsedDocument.');
    }

    const validatedCandidates = [];
    let evidenceRangesChecked = 0;

    for (const draft of drafts) {
        const validated = validateAndBuildFactCandidate(draft, parsedDocument, null, options);
        validatedCandidates.push(validated);

        if (Array.isArray(validated.evidence)) {
            for (const ev of validated.evidence) {
                if (Array.isArray(ev.spans)) {
                    evidenceRangesChecked += ev.spans.length;
                }
            }
        }
    }

    const validCount = validatedCandidates.filter((c) => c.validationStatus === 'valid').length;
    const invalidCount = validatedCandidates.length - validCount;

    const startedAt = timing.startedAt || new Date().toISOString();
    const completedAt = timing.completedAt || new Date().toISOString();
    const durationMs = typeof timing.durationMs === 'number'
        ? timing.durationMs
        : Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());

    const metrics = {
        candidatesProduced: validatedCandidates.length,
        validCandidates: validCount,
        invalidCandidates: invalidCount,
        evidenceRangesChecked,
        durationMs,
    };

    return deepFreeze({
        schemaVersion: EXTRACTION_RESULT_SCHEMA_VERSION,
        extractionRunId: String(runId || `run_${Date.now()}`),
        documentFingerprint: String(parsedDocument.documentFingerprint || ''),
        sourceChecksum: String(parsedDocument.sourceChecksum || ''),
        extractor: deepFreeze({
            name: String(extractor?.name || 'kos-unknown-extractor'),
            version: String(extractor?.version || '1.0.0'),
        }),
        startedAt,
        completedAt,
        candidates: validatedCandidates,
        warnings: [],
        errors: [],
        metrics: deepFreeze(metrics),
    });
}

module.exports = {
    EXTRACTION_RESULT_SCHEMA_VERSION,
    buildExtractionResult,
};
