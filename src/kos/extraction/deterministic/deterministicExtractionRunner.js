'use strict';

/**
 * WINE AI KOS - Deterministic Extraction Runner (Step 3B Production Pipeline)
 *
 * Pipeline flow:
 * 1. Extract CandidateDrafts from ParsedDocument.
 * 2. Validate and normalize candidates via Step 3A validator.
 * 3. Deduplicate valid candidates via Canonical JSON Key and detect conflicts.
 * 4. Construct ExtractionResult envelope with system metrics.
 */

const { getRegisteredExtractors, getExtractorRegistryFingerprint } = require('./extractorRegistry');
const { validateAndBuildFactCandidate } = require('../validation/candidateValidator');
const { deduplicateValidatedCandidates } = require('./candidateDeduplicator');
const { buildExtractionResult } = require('../contracts/extractionResult');

async function runDeterministicExtraction(parsedDocument, options = {}) {
    const startTime = Date.now();
    const startedAt = options.now ? options.now().toISOString() : new Date(startTime).toISOString();

    if (!parsedDocument) {
        throw new Error('runDeterministicExtraction requires a valid ParsedDocument object.');
    }

    const extractors = getRegisteredExtractors();
    const allDrafts = [];
    const runnerWarnings = [];
    const runnerErrors = [];

    for (const ext of extractors) {
        try {
            const res = ext.extractFn(parsedDocument, options);
            if (Array.isArray(res.drafts)) {
                allDrafts.push(...res.drafts);
            }
            if (Array.isArray(res.warnings)) {
                runnerWarnings.push(...res.warnings);
            }
        } catch (err) {
            runnerErrors.push({
                code: 'KOS_EXTRACTION_RUNNER_EXTRACTOR_FAILED',
                extractorName: ext.name,
                message: `Extractor "${ext.name}" threw an exception: ${err.message}`,
            });
        }
    }

    // 2. Validate & Normalize Drafts via Step 3A System Validator
    const validatedCandidates = allDrafts.map((draft) => validateAndBuildFactCandidate(draft, parsedDocument, null, options));

    // 3. Post-Validation Canonical Deduplication & Conflict Detection
    const { deduplicatedCandidates, warnings: dedupWarnings } = deduplicateValidatedCandidates(validatedCandidates);
    runnerWarnings.push(...dedupWarnings);

    const endTime = Date.now();
    const completedAt = options.now ? options.now().toISOString() : new Date(endTime).toISOString();
    const durationMs = options.now ? 0 : Math.max(0, endTime - startTime);

    // 4. Construct ExtractionResult Envelope with System Metrics
    const extractionResult = buildExtractionResult({
        runId: options.runId || `run_det_${Date.now()}`,
        parsedDocument,
        extractor: {
            name: 'kos-deterministic-pipeline',
            version: '1.0.0',
            registryFingerprint: getExtractorRegistryFingerprint(),
        },
        drafts: allDrafts,
        timing: { startedAt, completedAt, durationMs },
        options,
    });

    return {
        extractionResult,
        validatedCandidates: deduplicatedCandidates,
        warnings: [...runnerWarnings, ...extractionResult.warnings],
        errors: [...runnerErrors, ...extractionResult.errors],
    };
}

module.exports = {
    runDeterministicExtraction,
};
