'use strict';

/**
 * WINE AI KOS - PDF Format Adapter (Step 2B.1 Production Refined)
 *
 * Uses PDFParse / PDF.js engine to extract page text and item-level provenance:
 * `page.getTextContent().items` returning { str, transform, width, height, fontName, hasEOL }.
 * Enforces scanned PDF detection (KOS_PDF_OCR_REQUIRED), encrypted PDF rejection (KOS_PARSE_ENCRYPTED_PDF),
 * page-level & item-level structural provenance (`pdfLocation`).
 */

const crypto = require('crypto');
const PDFParse = require('pdf-parse').PDFParse;
const { KosParserError, createParsedDocument, createRange } = require('../core/parserContracts');
const { detectSuspiciousContent } = require('../core/suspiciousContentDetector');

const ADAPTER_NAME = 'kos-pdf-adapter';
const ADAPTER_VERSION = '1.0.0';

const PDF_LIMITS = {
    MAX_PAGES: 1000,
    MIN_TEXT_CHARS_PER_PAGE: 10,
    MAX_FILE_BYTES: 25 * 1024 * 1024, // 25MB
};

async function parsePdfFormat(buffer, metadata = {}, options = {}) {
    if (!Buffer.isBuffer(buffer)) {
        throw new KosParserError('KOS_PARSE_INVALID_INPUT_TYPE', 'PDF content must be a Buffer.');
    }

    if (buffer.length === 0) {
        throw new KosParserError('KOS_PARSE_EMPTY_SOURCE', 'PDF buffer is empty.');
    }

    if (buffer.length > PDF_LIMITS.MAX_FILE_BYTES) {
        throw new KosParserError('KOS_PARSE_FILE_TOO_LARGE', `PDF file size (${buffer.length} bytes) exceeds limit.`);
    }

    const header = buffer.toString('ascii', 0, Math.min(buffer.length, 1000));
    if (!header.includes('%PDF-')) {
        throw new KosParserError('KOS_PARSE_CORRUPTED_CONTAINER', 'Source is not a valid PDF file (missing %PDF- header).');
    }

    if (header.includes('/Encrypt') || buffer.includes(Buffer.from('/Encrypt'))) {
        throw new KosParserError('KOS_PARSE_ENCRYPTED_PDF', 'Encrypted or password-protected PDF files are not supported.');
    }

    const warnings = [];
    const transformations = [];
    const capabilityReasons = [];

    let pdfParser;
    try {
        const uint8Array = new Uint8Array(buffer);
        pdfParser = new PDFParse(uint8Array);
        await pdfParser.load();
    } catch (err) {
        if (err.name === 'PasswordException' || (err.message && err.message.includes('password'))) {
            throw new KosParserError('KOS_PARSE_ENCRYPTED_PDF', 'PDF is password-protected.');
        }
        throw new KosParserError('KOS_PARSE_CORRUPTED_CONTAINER', `Failed to load PDF structure: ${err.message.slice(0, 300)}`);
    }

    const numPages = pdfParser.doc ? pdfParser.doc.numPages : 0;
    if (numPages === 0) {
        throw new KosParserError('KOS_PARSE_CORRUPTED_CONTAINER', 'PDF document contains zero pages.');
    }

    if (numPages > PDF_LIMITS.MAX_PAGES) {
        throw new KosParserError('KOS_PARSE_FILE_TOO_LARGE', `PDF page count (${numPages}) exceeds maximum allowed limit (${PDF_LIMITS.MAX_PAGES}).`);
    }

    const structuralUnits = [];
    let canonicalText = '';
    let emptyPageCount = 0;

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        let pdfPage;
        let textContent;
        try {
            pdfPage = await pdfParser.doc.getPage(pageNum);
            textContent = await pdfPage.getTextContent();
        } catch (err) {
            warnings.push({ code: 'PDF_PAGE_DECODE_ERROR', pageNum, message: err.message.slice(0, 300) });
            continue;
        }

        const items = textContent.items || [];
        let pageText = '';

        for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
            const item = items[itemIdx];
            const str = item.str ? item.str.trim() : '';
            if (!str) continue;

            if (pageText.length > 0) pageText += ' ';
            pageText += str;

            if (canonicalText.length > 0) canonicalText += (canonicalText.endsWith('\n') ? '' : ' ');
            const contentStartUtf16 = canonicalText.length;
            canonicalText += str;
            const contentEndUtf16 = canonicalText.length;

            const unitId = `pdf_page_${String(pageNum).padStart(4, '0')}_item_${String(itemIdx + 1).padStart(4, '0')}`;
            structuralUnits.push({
                id: unitId,
                text: str,
                range: createRange({
                    utf16Start: contentStartUtf16,
                    utf16End: contentEndUtf16,
                    utf8ByteStart: Buffer.byteLength(canonicalText.slice(0, contentStartUtf16), 'utf8'),
                    utf8ByteEnd: Buffer.byteLength(canonicalText.slice(0, contentEndUtf16), 'utf8'),
                }),
                pdfLocation: {
                    pageNumber: pageNum,
                    itemStartIndex: itemIdx,
                    transform: item.transform || null,
                    width: item.width || null,
                    height: item.height || null,
                    fontName: item.fontName || null,
                    hasEOL: Boolean(item.hasEOL),
                },
            });
        }

        if (pageText.trim().length < PDF_LIMITS.MIN_TEXT_CHARS_PER_PAGE) {
            emptyPageCount++;
        }

        if (pageNum < numPages) {
            canonicalText += '\n\n';
        }
    }

    if (emptyPageCount === numPages) {
        throw new KosParserError('KOS_PDF_OCR_REQUIRED', `PDF appears to be scanned or image-only (${numPages} page(s) with insufficient text layer). OCR required.`);
    }

    if (emptyPageCount > 0) {
        capabilityReasons.push(`pdf_scanned_pages_${emptyPageCount}_of_${numPages}`);
        warnings.push({
            code: 'PDF_SCANNED_PAGES_DETECTED',
            message: `${emptyPageCount} of ${numPages} page(s) contain less than ${PDF_LIMITS.MIN_TEXT_CHARS_PER_PAGE} characters.`,
        });
    }

    const sourceChecksum = crypto.createHash('sha256').update(buffer).digest('hex');
    const suspiciousResult = detectSuspiciousContent(canonicalText);

    const capability = capabilityReasons.length > 0 ? 'partial' : 'full';

    return createParsedDocument({
        sourceChecksum,
        sourceMimeType: metadata.mimeType || 'application/pdf',
        sourceByteLength: buffer.length,
        rawText: canonicalText,
        canonicalText,
        sections: [
            {
                id: 'sec_0',
                type: 'preamble',
                headingText: null,
                bodyText: canonicalText,
                sourceText: canonicalText,
                range: createRange({
                    utf16Start: 0,
                    utf16End: canonicalText.length,
                    utf8ByteStart: 0,
                    utf8ByteEnd: Buffer.byteLength(canonicalText, 'utf8'),
                }),
            },
        ],
        suspiciousContent: suspiciousResult.findings,
        transformations,
        warnings: [...warnings, ...suspiciousResult.warnings],
        parserCapability: capability,
        parsedAt: options.now ? options.now().toISOString() : new Date().toISOString(),
        metadata: {
            ...metadata,
            pageCount: numPages,
            emptyPageCount,
            capabilityReasons,
        },
        structuralUnits,
        formatMetadata: {
            pageCount: numPages,
            emptyPageCount,
            adapterName: ADAPTER_NAME,
            adapterVersion: ADAPTER_VERSION,
        },
    });
}

module.exports = {
    parsePdfFormat,
    ADAPTER_NAME,
    ADAPTER_VERSION,
};
