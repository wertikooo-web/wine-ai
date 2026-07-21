'use strict';

/**
 * WINE AI KOS - PDF Format Adapter (Step 2C.4)
 *
 * Extracts text layer from PDF documents using pdf-parse:
 * - Rejects non-PDF files missing `%PDF-` header
 * - Rejects encrypted/password-protected PDFs (`/Encrypt`)
 * - Throws `KOS_PARSE_PDF_NO_TEXT` if PDF consists only of images / zero text
 */

const { normalizeText } = require('../parsedDocumentBuilder');

const ADAPTER_NAME = 'pdf_adapter';
const ADAPTER_VERSION = '1.0.0';

async function parse({ rawBody }) {
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
        throw Object.assign(new Error('KOS_PDF_PARSE_BUFFER_REQUIRED'), { code: 'KOS_PDF_PARSE_BUFFER_REQUIRED' });
    }

    if (rawBody.length === 0) {
        throw Object.assign(new Error('KOS_PDF_EMPTY_BUFFER'), { code: 'KOS_PDF_EMPTY_BUFFER' });
    }

    const header = rawBody.toString('ascii', 0, Math.min(rawBody.length, 1000));
    if (!header.includes('%PDF-')) {
        throw Object.assign(new Error('KOS_PARSE_CORRUPTED_CONTAINER: Missing %PDF- header'), { code: 'KOS_PARSE_CORRUPTED_CONTAINER' });
    }

    if (header.includes('/Encrypt') || rawBody.includes(Buffer.from('/Encrypt'))) {
        throw Object.assign(new Error('KOS_PARSE_ENCRYPTED_PDF: Password-protected or encrypted PDF'), { code: 'KOS_PARSE_ENCRYPTED_PDF' });
    }

    let extractedText = '';
    try {
        // Require pdf-parse
        let pdfParseFn;
        try {
            const pdfMod = require('pdf-parse');
            pdfParseFn = typeof pdfMod === 'function' ? pdfMod : (pdfMod.default || pdfMod.PDFParse);
        } catch {
            pdfParseFn = null;
        }

        if (pdfParseFn && typeof pdfParseFn === 'function') {
            const parsedData = await pdfParseFn(rawBody);
            extractedText = parsedData.text || '';
        } else {
            // Fallback plain text extraction over ASCII text stream
            extractedText = rawBody.toString('utf8').replace(/[^\x20-\x7E\n\r]/g, ' ');
        }
    } catch (err) {
        throw Object.assign(new Error(`KOS_PDF_PARSE_FAILED: ${err.message}`), { code: 'KOS_PDF_PARSE_FAILED' });
    }

    const normalized = normalizeText(extractedText);
    if (!normalized || normalized.length < 5) {
        throw Object.assign(
            new Error('KOS_PARSE_PDF_NO_TEXT: PDF document contains no extractable text layer (scanned/image-only)'),
            { code: 'KOS_PARSE_PDF_NO_TEXT' }
        );
    }

    const paragraphs = normalized.split(/\n\s*\n/);
    const blocks = [];

    for (const p of paragraphs) {
        const trimmed = normalizeText(p);
        if (trimmed) {
            blocks.push({
                type: 'paragraph',
                text: trimmed,
            });
        }
    }

    if (blocks.length === 0) {
        throw Object.assign(
            new Error('KOS_PARSE_PDF_NO_TEXT: PDF document contains no extractable text layer'),
            { code: 'KOS_PARSE_PDF_NO_TEXT' }
        );
    }

    return {
        title: '',
        blocks,
        warnings: [],
    };
}

module.exports = {
    parse,
    ADAPTER_NAME,
    ADAPTER_VERSION,
};
