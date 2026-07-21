'use strict';

/**
 * WINE AI KOS - Multi-Span Evidence Contract & Validation (Step 3B Refined Boundary)
 *
 * Extractor produces pure EvidenceDrafts (quote, range, structuralUnitIds) WITHOUT source identity.
 * System Evidence Resolver binds ParsedDocument sourceId, sourceChecksum, documentFingerprint, and formatLocations.
 */

const { deepFreeze } = require('../helpers/deepFreeze');

const EVIDENCE_TYPES = Object.freeze([
    'direct_quote',
    'table_cell',
    'heading_context',
    'label_value_pair',
    'multi_span',
    'derived_from_structure',
]);

function createEvidenceSpan(data = {}) {
    if (!data.quote || typeof data.quote !== 'string') {
        throw new Error('Evidence span requires a non-empty quote string.');
    }
    if (!data.range || typeof data.range.utf16Start !== 'number' || typeof data.range.utf16End !== 'number') {
        throw new Error('Evidence span requires a valid range object ({ utf16Start, utf16End }).');
    }

    return deepFreeze({
        quote: data.quote,
        range: {
            representation: 'canonical-v1',
            utf16Start: Math.max(0, data.range.utf16Start),
            utf16End: Math.max(0, data.range.utf16End),
            utf8ByteStart: Number.isInteger(data.range.utf8ByteStart) ? Math.max(0, data.range.utf8ByteStart) : null,
            utf8ByteEnd: Number.isInteger(data.range.utf8ByteEnd) ? Math.max(0, data.range.utf8ByteEnd) : null,
        },
        structuralUnitIds: Array.isArray(data.structuralUnitIds) ? [...data.structuralUnitIds] : [],
        formatLocations: Array.isArray(data.formatLocations) ? [...data.formatLocations] : [],
    });
}

function createEvidenceDraft(data = {}) {
    const type = EVIDENCE_TYPES.includes(data.evidenceType) ? data.evidenceType : 'direct_quote';
    const rawSpans = Array.isArray(data.spans) && data.spans.length > 0
        ? data.spans
        : (data.quote && data.range ? [{ quote: data.quote, range: data.range, structuralUnitIds: data.structuralUnitIds }] : []);

    if (rawSpans.length === 0) {
        throw new Error('EvidenceDraft requires at least one span or quote/range combination.');
    }

    const spans = rawSpans.map(createEvidenceSpan);

    return deepFreeze({
        evidenceType: spans.length > 1 && type !== 'label_value_pair' && type !== 'table_cell' ? 'multi_span' : type,
        spans,
        extractionNotes: data.extractionNotes ? String(data.extractionNotes) : null,
    });
}

function resolveSystemEvidence(evidenceDraft, parsedDocument = null) {
    const draft = createEvidenceDraft(evidenceDraft);

    const sourceId = parsedDocument?.sourceId || 'src_unknown';
    const sourceChecksum = parsedDocument?.sourceChecksum || '';
    const documentFingerprint = parsedDocument?.documentFingerprint || '';

    // Derive formatLocations strictly from structuralUnits matching structuralUnitIds
    const validUnitsMap = new Map((parsedDocument?.structuralUnits || []).map((u) => [u.id, u]));
    const resolvedSpans = draft.spans.map((span) => {
        const formatLocations = [];
        for (const unitId of span.structuralUnitIds) {
            const u = validUnitsMap.get(unitId);
            if (u) {
                if (u.docxLocation) formatLocations.push({ format: 'docx', ...u.docxLocation });
                if (u.htmlLocation) formatLocations.push({ format: 'html', ...u.htmlLocation });
                if (u.pdfLocation) formatLocations.push({ format: 'pdf', ...u.pdfLocation });
            }
        }

        return deepFreeze({
            ...span,
            formatLocations: deepFreeze(formatLocations),
        });
    });

    return deepFreeze({
        sourceId,
        sourceChecksum,
        documentFingerprint,
        evidenceType: draft.evidenceType,
        spans: resolvedSpans,
        extractionNotes: draft.extractionNotes,
    });
}

function isSurrogateBoundary(str, index) {
    if (index <= 0 || index >= str.length) return true;
    const prevChar = str.charCodeAt(index - 1);
    const currChar = str.charCodeAt(index);
    if (prevChar >= 0xd800 && prevChar <= 0xdbff && currChar >= 0xdc00 && currChar <= 0xdfff) {
        return false;
    }
    return true;
}

function verifyEvidenceSpan(canonicalText, span) {
    if (!canonicalText || typeof canonicalText !== 'string') return { isValid: false, code: 'KOS_FACT_CANONICAL_TEXT_MISSING' };
    if (!span || !span.range || typeof span.quote !== 'string') return { isValid: false, code: 'KOS_FACT_SPAN_INVALID' };

    const { utf16Start, utf16End, utf8ByteStart, utf8ByteEnd, representation } = span.range;

    if (representation !== 'canonical-v1') {
        return { isValid: false, code: 'KOS_FACT_RANGE_REPRESENTATION_INVALID' };
    }

    if (!Number.isInteger(utf16Start) || !Number.isInteger(utf16End) || utf16Start < 0 || utf16End < utf16Start || utf16End > canonicalText.length) {
        return { isValid: false, code: 'KOS_FACT_EVIDENCE_RANGE_INVALID' };
    }

    if (!isSurrogateBoundary(canonicalText, utf16Start) || !isSurrogateBoundary(canonicalText, utf16End)) {
        return { isValid: false, code: 'KOS_FACT_SURROGATE_PAIR_SPLIT' };
    }

    const actualQuote = canonicalText.slice(utf16Start, utf16End);
    if (actualQuote !== span.quote) {
        return { isValid: false, code: 'KOS_FACT_QUOTE_MISMATCH', actualQuote, expectedQuote: span.quote };
    }

    if (typeof utf8ByteStart === 'number' && typeof utf8ByteEnd === 'number') {
        const calculatedStart = Buffer.byteLength(canonicalText.slice(0, utf16Start), 'utf8');
        const calculatedEnd = Buffer.byteLength(canonicalText.slice(0, utf16End), 'utf8');
        if (calculatedStart !== utf8ByteStart || calculatedEnd !== utf8ByteEnd) {
            return { isValid: false, code: 'KOS_FACT_UTF8_RANGE_INVALID', calculatedStart, calculatedEnd };
        }
    }

    return { isValid: true };
}

module.exports = {
    EVIDENCE_TYPES,
    createEvidenceSpan,
    createEvidenceDraft,
    resolveSystemEvidence,
    verifyEvidenceSpan,
    isSurrogateBoundary,
};
