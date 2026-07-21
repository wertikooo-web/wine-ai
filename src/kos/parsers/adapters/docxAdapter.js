'use strict';

/**
 * WINE AI KOS - DOCX Format Adapter (Step 2B.1 Production Refined)
 *
 * Uses adm-zip (v0.6.0) for ZIP container inspection + @xmldom/xmldom (v0.9.10) for XML DOM parsing.
 * Granular ZIP security errors, DTD/XXE pre-scanning, OpenXML parts parsing (styles, numbering, footnotes, endnotes, rels),
 * paragraph/table provenance tracking (`docxLocation`).
 */

const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { DOMParser } = require('@xmldom/xmldom');
const { KosParserError, createParsedDocument, createRange } = require('../core/parserContracts');
const { detectSuspiciousContent } = require('../core/suspiciousContentDetector');

const ADAPTER_NAME = 'kos-docx-adapter';
const ADAPTER_VERSION = '1.0.0';

const DOCX_LIMITS = {
    MAX_ZIP_ENTRIES: 100,
    MAX_ENTRY_BYTES: 10 * 1024 * 1024, // 10MB
    MAX_UNCOMPRESSED_BYTES: 20 * 1024 * 1024, // 20MB
    MAX_COMPRESSION_RATIO: 10,
    MAX_PARAGRAPHS: 10_000,
};

function sanitizeXmlString(xmlString) {
    if (/<!DOCTYPE\b/i.test(xmlString) || /<!ENTITY\b/i.test(xmlString)) {
        throw new KosParserError(
            'KOS_PARSE_CORRUPTED_CONTAINER',
            'DTD or external entity declaration detected in XML structure (XXE prevention).'
        );
    }
}

function parseXmlDom(xmlString, warnings = []) {
    sanitizeXmlString(xmlString);
    const domParser = new DOMParser({
        onError: (level, msg) => {
            if (level === 'warning' || level === 'error') {
                warnings.push({ code: 'XML_DOM_WARNING', message: msg.slice(0, 300) });
            }
        },
    });
    return domParser.parseFromString(xmlString, 'text/xml');
}

function getElementText(el) {
    if (!el) return '';
    const textNodes = el.getElementsByTagName('w:t');
    let text = '';
    for (let i = 0; i < textNodes.length; i++) {
        text += textNodes[i].textContent || '';
    }
    return text.trim();
}

async function parseDocxFormat(buffer, metadata = {}, options = {}) {
    if (!Buffer.isBuffer(buffer)) {
        throw new KosParserError('KOS_PARSE_INVALID_INPUT_TYPE', 'DOCX content must be a Buffer.');
    }

    if (buffer.length === 0) {
        throw new KosParserError('KOS_PARSE_EMPTY_SOURCE', 'DOCX buffer is empty.');
    }

    if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
        throw new KosParserError('KOS_PARSE_CORRUPTED_CONTAINER', 'Source is not a valid ZIP container (missing PK magic header).');
    }

    const warnings = [];
    const transformations = [];
    const capabilityReasons = [];

    let zip;
    try {
        zip = new AdmZip(buffer);
    } catch (err) {
        throw new KosParserError('KOS_PARSE_CORRUPTED_CONTAINER', `Failed to open ZIP archive: ${err.message.slice(0, 300)}`);
    }

    const entries = zip.getEntries();
    if (entries.length > DOCX_LIMITS.MAX_ZIP_ENTRIES) {
        throw new KosParserError(
            'KOS_DOCX_TOO_MANY_ENTRIES',
            `ZIP container entry count (${entries.length}) exceeds maximum limit (${DOCX_LIMITS.MAX_ZIP_ENTRIES}).`
        );
    }

    let actualTotalBytes = 0;
    let hasMacros = false;
    const seenEntries = new Set();

    for (const entry of entries) {
        const name = entry.entryName;
        const normalized = name.replaceAll('\\', '/');
        const segments = normalized.split('/');

        // Segment-level path traversal validation
        if (normalized.startsWith('/') || normalized.includes('\0') || segments.some((seg) => seg === '..')) {
            throw new KosParserError('KOS_DOCX_UNSAFE_ENTRY_NAME', `Unsafe path traversal entry name: "${name}".`);
        }

        const lowerName = normalized.toLowerCase();
        if (seenEntries.has(lowerName)) {
            throw new KosParserError('KOS_DOCX_DUPLICATE_ENTRY', `Duplicate entry name in ZIP archive: "${name}".`);
        }
        seenEntries.add(lowerName);

        if (entry.header.flags & 1) {
            throw new KosParserError('KOS_DOCX_ENCRYPTED_ENTRY', `ZIP entry "${name}" is encrypted.`);
        }

        const uncompressedSize = entry.header.size;
        const compressedSize = entry.header.compressedSize;

        if (compressedSize > 0 && uncompressedSize / compressedSize > DOCX_LIMITS.MAX_COMPRESSION_RATIO) {
            throw new KosParserError(
                'KOS_DOCX_COMPRESSION_RATIO_EXCEEDED',
                `ZIP entry "${name}" exceeds maximum compression ratio (${DOCX_LIMITS.MAX_COMPRESSION_RATIO}x). Potential Zip Bomb.`
            );
        }

        // Validate unpacked bytes directly
        let entryData;
        try {
            entryData = entry.getData();
        } catch (err) {
            throw new KosParserError('KOS_DOCX_DECOMPRESSION_FAILED', `Failed to decompress ZIP entry "${name}".`);
        }

        if (entryData.length > DOCX_LIMITS.MAX_ENTRY_BYTES) {
            throw new KosParserError(
                'KOS_DOCX_ENTRY_TOO_LARGE',
                `ZIP entry "${name}" size (${entryData.length} bytes) exceeds limit (${DOCX_LIMITS.MAX_ENTRY_BYTES}).`
            );
        }

        actualTotalBytes += entryData.length;
        if (actualTotalBytes > DOCX_LIMITS.MAX_UNCOMPRESSED_BYTES) {
            throw new KosParserError(
                'KOS_DOCX_TOTAL_UNCOMPRESSED_TOO_LARGE',
                `Total uncompressed ZIP size (${actualTotalBytes} bytes) exceeds limit (${DOCX_LIMITS.MAX_UNCOMPRESSED_BYTES}).`
            );
        }

        if (lowerName.includes('vbaproject.bin') || lowerName.includes('vbalocation')) {
            hasMacros = true;
        }
    }

    if (hasMacros) {
        throw new KosParserError('KOS_PARSE_UNSUPPORTED_FORMAT', 'DOCM macro-enabled files are quarantined and unsupported.');
    }

    const docEntry = zip.getEntry('word/document.xml');
    if (!docEntry) {
        throw new KosParserError('KOS_PARSE_CORRUPTED_CONTAINER', 'DOCX container is missing word/document.xml.');
    }

    const xmlString = zip.readAsText(docEntry);
    if (Buffer.byteLength(xmlString, 'utf8') > DOCX_LIMITS.MAX_ENTRY_BYTES) {
        throw new KosParserError('KOS_DOCX_XML_TOO_LARGE', 'word/document.xml size exceeds maximum allowed limit.');
    }

    // 2. Parse OpenXML Parts (styles, numbering, footnotes, endnotes, rels)
    const styleMap = new Map();
    const stylesEntry = zip.getEntry('word/styles.xml');
    if (stylesEntry) {
        try {
            const stylesXml = zip.readAsText(stylesEntry);
            const stylesDoc = parseXmlDom(stylesXml, warnings);
            const styleEls = stylesDoc.getElementsByTagName('w:style');
            for (let i = 0; i < styleEls.length; i++) {
                const sId = styleEls[i].getAttribute('w:styleId');
                const nameEl = styleEls[i].getElementsByTagName('w:name')[0];
                const sName = nameEl ? nameEl.getAttribute('w:val') : '';
                if (sId) styleMap.set(sId, sName);
            }
        } catch {}
    }

    const footnotes = [];
    const footnotesEntry = zip.getEntry('word/footnotes.xml');
    if (footnotesEntry) {
        try {
            const fnXml = zip.readAsText(footnotesEntry);
            const fnDoc = parseXmlDom(fnXml, warnings);
            const fnEls = fnDoc.getElementsByTagName('w:footnote');
            for (let i = 0; i < fnEls.length; i++) {
                const fnText = getElementText(fnEls[i]);
                if (fnText) footnotes.push(fnText);
            }
        } catch {}
    }

    const endnotes = [];
    const endnotesEntry = zip.getEntry('word/endnotes.xml');
    if (endnotesEntry) {
        try {
            const enXml = zip.readAsText(endnotesEntry);
            const enDoc = parseXmlDom(enXml, warnings);
            const enEls = enDoc.getElementsByTagName('w:endnote');
            for (let i = 0; i < enEls.length; i++) {
                const enText = getElementText(enEls[i]);
                if (enText) endnotes.push(enText);
            }
        } catch {}
    }

    const mainDoc = parseXmlDom(xmlString, warnings);
    const structuralUnits = [];
    let canonicalText = '';
    let paragraphIndex = 0;
    let tableIndex = 0;

    const bodyNode = mainDoc.getElementsByTagName('w:body')[0] || mainDoc.documentElement;
    const paragraphs = bodyNode.getElementsByTagName('w:p');

    for (let i = 0; i < paragraphs.length; i++) {
        if (paragraphIndex >= DOCX_LIMITS.MAX_PARAGRAPHS) break;
        const pEl = paragraphs[i];
        const pText = getElementText(pEl);

        if (!pText) continue;

        paragraphIndex++;
        const pStyleEl = pEl.getElementsByTagName('w:pStyle')[0];
        const styleId = pStyleEl ? pStyleEl.getAttribute('w:val') : '';
        const styleName = styleMap.get(styleId) || styleId || '';
        const isHeading = styleId.toLowerCase().includes('heading') || styleName.toLowerCase().includes('heading');

        if (canonicalText.length > 0) canonicalText += '\n\n';
        const contentStartUtf16 = canonicalText.length;

        const textToAdd = isHeading ? `# ${pText}` : pText;
        canonicalText += textToAdd;
        const contentEndUtf16 = canonicalText.length;

        const unitId = `docx_paragraph_${String(paragraphIndex).padStart(6, '0')}`;
        structuralUnits.push({
            id: unitId,
            text: textToAdd,
            range: createRange({
                utf16Start: contentStartUtf16,
                utf16End: contentEndUtf16,
                utf8ByteStart: Buffer.byteLength(canonicalText.slice(0, contentStartUtf16), 'utf8'),
                utf8ByteEnd: Buffer.byteLength(canonicalText.slice(0, contentEndUtf16), 'utf8'),
            }),
            docxLocation: {
                paragraphIndex,
                tableIndex: null,
                rowIndex: null,
                cellIndex: null,
            },
        });
    }

    // Process Tables (<w:tbl>)
    const tables = bodyNode.getElementsByTagName('w:tbl');
    for (let t = 0; t < tables.length; t++) {
        tableIndex++;
        const tbl = tables[t];
        const rows = tbl.getElementsByTagName('w:tr');

        for (let r = 0; r < rows.length; r++) {
            const row = rows[r];
            const cells = row.getElementsByTagName('w:tc');

            for (let c = 0; c < cells.length; c++) {
                const cell = cells[c];
                const cellText = getElementText(cell);
                if (!cellText) continue;

                if (canonicalText.length > 0) canonicalText += '\n';
                const contentStartUtf16 = canonicalText.length;
                canonicalText += cellText;
                const contentEndUtf16 = canonicalText.length;

                const unitId = `docx_table_${String(tableIndex).padStart(6, '0')}_row_${String(r + 1).padStart(6, '0')}_cell_${String(c + 1).padStart(6, '0')}`;
                structuralUnits.push({
                    id: unitId,
                    text: cellText,
                    range: createRange({
                        utf16Start: contentStartUtf16,
                        utf16End: contentEndUtf16,
                        utf8ByteStart: Buffer.byteLength(canonicalText.slice(0, contentStartUtf16), 'utf8'),
                        utf8ByteEnd: Buffer.byteLength(canonicalText.slice(0, contentEndUtf16), 'utf8'),
                    }),
                    docxLocation: {
                        paragraphIndex: null,
                        tableIndex,
                        rowIndex: r + 1,
                        cellIndex: c + 1,
                    },
                });
            }
        }
    }

    // Append footnotes & endnotes if present
    if (footnotes.length > 0) {
        canonicalText += '\n\n--- Footnotes ---\n' + footnotes.join('\n');
    }
    if (endnotes.length > 0) {
        canonicalText += '\n\n--- Endnotes ---\n' + endnotes.join('\n');
    }

    if (!canonicalText.trim()) {
        canonicalText = getElementText(mainDoc.documentElement);
    }

    const sourceChecksum = crypto.createHash('sha256').update(buffer).digest('hex');
    const suspiciousResult = detectSuspiciousContent(canonicalText);

    const capability = capabilityReasons.length > 0 ? 'partial' : 'full';

    return createParsedDocument({
        sourceChecksum,
        sourceMimeType: metadata.mimeType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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
            paragraphCount: paragraphIndex,
            tableCount: tableIndex,
            footnotesCount: footnotes.length,
            endnotesCount: endnotes.length,
            capabilityReasons,
        },
        structuralUnits,
        formatMetadata: {
            paragraphCount: paragraphIndex,
            tableCount: tableIndex,
            footnotes,
            endnotes,
            hasMacros,
            adapterName: ADAPTER_NAME,
            adapterVersion: ADAPTER_VERSION,
        },
    });
}

module.exports = {
    parseDocxFormat,
    ADAPTER_NAME,
    ADAPTER_VERSION,
};
