'use strict';

/**
 * WINE AI KOS - Text Parser Core Orchestrator (Step 2B Core)
 */

const crypto = require('crypto');
const { KosParserError, createParsedDocument, createParserFingerprint } = require('./parserContracts');
const { decodeText } = require('./textDecoder');
const { normalizeText } = require('./textNormalizer');
const { segmentDocument } = require('./sectionSegmenter');
const { detectSuspiciousContent } = require('./suspiciousContentDetector');

function parseTextDocument(rawBufferOrString, metadata = {}, options = {}) {
    const {
        sourceId = null,
        documentType = 'unknown',
        declaredMimeType = 'text/plain',
        title = '',
    } = metadata;

    const mimeType = metadata.mimeType || declaredMimeType;
    const expectedChecksum = options.expectedChecksum || metadata.expectedChecksum || null;

    const buffer = Buffer.isBuffer(rawBufferOrString)
        ? rawBufferOrString
        : Buffer.from(String(rawBufferOrString || ''), 'utf8');

    const sourceChecksum = crypto.createHash('sha256').update(buffer).digest('hex');

    if (expectedChecksum && expectedChecksum !== sourceChecksum) {
        throw new KosParserError(
            'KOS_PARSE_SOURCE_CHECKSUM_MISMATCH',
            `Provided expectedChecksum (${expectedChecksum}) does not match calculated source checksum (${sourceChecksum}).`
        );
    }

    const decoded = decodeText(rawBufferOrString, options);
    const warnings = [...decoded.warnings];

    const normalized = normalizeText(decoded);
    const { canonicalText, transformations } = normalized;

    let parserCapability = 'full';
    if (mimeType.toLowerCase() === 'text/html') {
        parserCapability = 'limited';
        warnings.push({
            code: 'HTML_PARSER_LIMITED',
            message: 'Raw HTML document parsed as plain text without DOM extraction. Use HTML adapter for structural parsing.',
        });
    }

    const { sections, codeBlockRanges } = segmentDocument(canonicalText, title);

    const suspiciousResult = detectSuspiciousContent(canonicalText, codeBlockRanges);
    const suspiciousContent = suspiciousResult.findings;
    warnings.push(...suspiciousResult.warnings);

    if (suspiciousContent.some((s) => s.severity === 'high')) {
        warnings.push({
            code: 'SUSPICIOUS_INSTRUCTIONS_DETECTED',
            message: 'Potential prompt injection instructions detected and tagged in source content.',
        });
    }

    const parsedAt = options.now ? options.now().toISOString() : new Date().toISOString();

    return createParsedDocument({
        sourceChecksum,
        sourceMimeType: mimeType,
        sourceByteLength: decoded.byteLength,
        rawText: decoded.rawText,
        canonicalText,
        sections,
        suspiciousContent,
        transformations,
        warnings,
        parserCapability,
        parsedAt,
        metadata: {
            ...metadata,
            sourceId,
            documentType,
        },
    });
}

module.exports = {
    parseTextDocument,
    createParserFingerprint,
    KosParserError,
};
