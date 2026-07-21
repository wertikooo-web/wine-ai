'use strict';

/**
 * WINE AI KOS - Parser Core Contracts & Typed Errors (Step 2A Refined)
 *
 * Defines structured output models, schema versioning, offset ranges, and typed error handling.
 */

const crypto = require('crypto');

class KosParserError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'KosParserError';
        this.code = code;
        this.details = details;
    }
}

const PARSER_SCHEMA_VERSION = '1.0.0';
const PARSER_NAME = 'kos-text-parser';
const PARSER_VERSION = '1.0.0';
const NORMALIZATION_VERSION = '1.0.0';
const SUSPICIOUS_DETECTOR_VERSION = '1.0.0';

const PARSER_LIMITS = {
    MAX_INPUT_BYTES: Number(process.env.KOS_MAX_SOURCE_SIZE_BYTES || 20 * 1024 * 1024), // 20MB
    MAX_TEXT_LENGTH: 10_000_000,
    MAX_SECTIONS: 1_000,
    MAX_HEADING_LENGTH: 300,
    MAX_WARNINGS: 100,
    MAX_SUSPICIOUS_MARKERS: 100,
};

const ALLOWED_METADATA_KEYS = new Set([
    'sourceId',
    'originalFilename',
    'originalUrl',
    'declaredMimeType',
    'languageHint',
    'documentType',
]);

function sanitizeMetadata(metadata = {}) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return {};
    }

    const clean = {};
    for (const key of Object.keys(metadata)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        if (ALLOWED_METADATA_KEYS.has(key)) {
            const val = metadata[key];
            if (typeof val === 'string') {
                clean[key] = val.slice(0, 1000).replace(/[\x00-\x1F\x7F]/g, '');
            } else if (typeof val === 'number' || typeof val === 'boolean') {
                clean[key] = val;
            }
        }
    }
    return clean;
}

function createRange({ utf16Start = 0, utf16End = 0, utf8ByteStart = 0, utf8ByteEnd = 0 }) {
    return {
        representation: 'canonical-v1',
        utf16Start: Number(utf16Start),
        utf16End: Number(utf16End),
        utf8ByteStart: Number(utf8ByteStart),
        utf8ByteEnd: Number(utf8ByteEnd),
        rawRangeStatus: 'not_mapped',
    };
}

function createDocumentSection({
    id,
    type = 'section', // 'preamble' | 'section'
    headingText = null,
    bodyText = '',
    sourceText = '',
    range,
    headingRange = null,
    bodyRange = null,
}) {
    return {
        id: id || (type === 'preamble' ? 'sec_preamble' : `sec_${Math.random().toString(36).substring(2, 9)}`),
        type,
        headingText: type === 'preamble' ? null : (headingText ? String(headingText).trim() : null),
        bodyText: String(bodyText || ''),
        sourceText: String(sourceText || ''),
        range: range || createRange({}),
        headingRange,
        bodyRange,
    };
}

function createParsedDocument({
    sourceChecksum,
    sourceMimeType,
    sourceByteLength,
    rawText,
    canonicalText,
    sections = [],
    suspiciousContent = [],
    transformations = [],
    warnings = [],
    parserCapability = 'full',
    parsedAt,
    metadata = {},
}) {
    return {
        schemaVersion: PARSER_SCHEMA_VERSION,
        parserName: PARSER_NAME,
        parserVersion: PARSER_VERSION,
        normalizationVersion: NORMALIZATION_VERSION,
        suspiciousContentDetectionVersion: SUSPICIOUS_DETECTOR_VERSION,
        sourceChecksum,
        sourceMimeType,
        sourceByteLength,
        rawText,
        canonicalText,
        totalUtf16Units: canonicalText.length,
        totalUtf8Bytes: Buffer.byteLength(canonicalText, 'utf8'),
        sections: sections.map(createDocumentSection),
        suspiciousContent,
        transformations,
        warnings,
        parserCapability,
        parsedAt: parsedAt || new Date().toISOString(),
        metadata: sanitizeMetadata(metadata),
    };
}

function createParserFingerprint(parsedDocument) {
    if (!parsedDocument || typeof parsedDocument !== 'object') {
        throw new Error('createParserFingerprint: parsedDocument object is required.');
    }

    const payload = `${parsedDocument.sourceChecksum}:${parsedDocument.parserName}:${parsedDocument.parserVersion}:${parsedDocument.normalizationVersion}:${parsedDocument.schemaVersion}`;
    return crypto.createHash('sha256').update(payload).digest('hex');
}

module.exports = {
    KosParserError,
    PARSER_SCHEMA_VERSION,
    PARSER_NAME,
    PARSER_VERSION,
    NORMALIZATION_VERSION,
    SUSPICIOUS_DETECTOR_VERSION,
    PARSER_LIMITS,
    sanitizeMetadata,
    createRange,
    createDocumentSection,
    createParsedDocument,
    createParserFingerprint,
};
