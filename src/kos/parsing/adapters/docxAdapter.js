'use strict';

/**
 * WINE AI KOS - DOCX Format Adapter (Step 2C.4)
 *
 * Unpacks DOCX OpenXML package using adm-zip and parses `word/document.xml`:
 * - Enforces ZIP entry limits (max 1000 entries) and uncompressed size limits (max 25 MB)
 * - XXE pre-scanning (blocks DTD and ENTITY declarations)
 * - Extracts headings, paragraphs, lists, and table rows into blocks
 */

const AdmZip = require('adm-zip');
const { DOMParser } = require('@xmldom/xmldom');
const { normalizeText } = require('../parsedDocumentBuilder');

const ADAPTER_NAME = 'docx_adapter';
const ADAPTER_VERSION = '1.0.0';

const DOCX_LIMITS = {
    MAX_ZIP_ENTRIES: 1000,
    MAX_UNCOMPRESSED_BYTES: 25 * 1024 * 1024, // 25 MB
};

function sanitizeXmlString(xmlString) {
    if (/<!DOCTYPE\b/i.test(xmlString) || /<!ENTITY\b/i.test(xmlString)) {
        throw Object.assign(
            new Error('KOS_PARSE_XXE_BLOCKED: DTD or entity declaration in XML'),
            { code: 'KOS_PARSE_XXE_BLOCKED' }
        );
    }
}

function getElementText(el) {
    if (!el) return '';
    const textNodes = el.getElementsByTagName('w:t');
    let text = '';
    for (let i = 0; i < textNodes.length; i++) {
        text += textNodes[i].textContent || '';
    }
    return text;
}

async function parse({ rawBody }) {
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
        throw Object.assign(new Error('KOS_DOCX_PARSE_BUFFER_REQUIRED'), { code: 'KOS_DOCX_PARSE_BUFFER_REQUIRED' });
    }

    if (rawBody.length < 4 || rawBody[0] !== 0x50 || rawBody[1] !== 0x4b || rawBody[2] !== 0x03 || rawBody[3] !== 0x04) {
        throw Object.assign(new Error('KOS_PARSE_CORRUPTED_CONTAINER: Not a valid ZIP/DOCX container'), { code: 'KOS_PARSE_CORRUPTED_CONTAINER' });
    }

    let zip;
    try {
        zip = new AdmZip(rawBody);
    } catch (err) {
        throw Object.assign(new Error(`KOS_PARSE_CORRUPTED_CONTAINER: Failed to unpack ZIP: ${err.message}`), { code: 'KOS_PARSE_CORRUPTED_CONTAINER' });
    }

    const entries = zip.getEntries();
    if (entries.length > DOCX_LIMITS.MAX_ZIP_ENTRIES) {
        throw Object.assign(
            new Error(`KOS_DOCX_LIMIT_EXCEEDED: ZIP entries (${entries.length}) exceed max limit ${DOCX_LIMITS.MAX_ZIP_ENTRIES}`),
            { code: 'KOS_DOCX_LIMIT_EXCEEDED' }
        );
    }

    let totalUncompressedSize = 0;
    for (const entry of entries) {
        totalUncompressedSize += entry.header.size;
        if (totalUncompressedSize > DOCX_LIMITS.MAX_UNCOMPRESSED_BYTES) {
            throw Object.assign(
                new Error(`KOS_DOCX_LIMIT_EXCEEDED: Uncompressed size exceeds limit ${DOCX_LIMITS.MAX_UNCOMPRESSED_BYTES}`),
                { code: 'KOS_DOCX_LIMIT_EXCEEDED' }
            );
        }
    }

    const docEntry = zip.getEntry('word/document.xml');
    if (!docEntry) {
        throw Object.assign(new Error('KOS_PARSE_CORRUPTED_CONTAINER: Missing word/document.xml in DOCX'), { code: 'KOS_PARSE_CORRUPTED_CONTAINER' });
    }

    const xmlString = zip.readAsText(docEntry);
    sanitizeXmlString(xmlString);

    const domParser = new DOMParser({ onError: () => {} });
    const doc = domParser.parseFromString(xmlString, 'text/xml');

    const blocks = [];
    const warnings = [];

    // Parse paragraphs <w:p> and tables <w:tr>
    const paragraphs = doc.getElementsByTagName('w:p');
    for (let i = 0; i < paragraphs.length; i++) {
        const p = paragraphs[i];
        const rawText = getElementText(p);
        const text = normalizeText(rawText);

        if (!text) continue;

        // Check if paragraph is heading
        let headingLevel;
        const pStyle = p.getElementsByTagName('w:pStyle')[0];
        if (pStyle) {
            const val = pStyle.getAttribute('w:val') || '';
            const match = val.match(/Heading(\d)/i) || val.match(/Heading\s*(\d)/i);
            if (match) {
                headingLevel = parseInt(match[1], 10);
            }
        }

        // Check list item
        const numPr = p.getElementsByTagName('w:numPr')[0];
        const isList = Boolean(numPr);

        if (headingLevel) {
            blocks.push({
                type: 'heading',
                text,
                headingLevel,
            });
        } else if (isList) {
            blocks.push({
                type: 'list_item',
                text,
            });
        } else {
            blocks.push({
                type: 'paragraph',
                text,
            });
        }
    }

    // Parse table rows <w:tr>
    const rows = doc.getElementsByTagName('w:tr');
    for (let i = 0; i < rows.length; i++) {
        const tr = rows[i];
        const cells = tr.getElementsByTagName('w:tc');
        const cellTexts = [];

        for (let j = 0; j < cells.length; j++) {
            const cellText = normalizeText(getElementText(cells[j]));
            if (cellText) cellTexts.push(cellText);
        }

        if (cellTexts.length > 0) {
            blocks.push({
                type: 'table_row',
                text: cellTexts.join(' | '),
            });
        }
    }

    if (blocks.length === 0) {
        warnings.push('DOCX document contained no extractable text elements');
    }

    return {
        title: '',
        blocks,
        warnings,
    };
}

module.exports = {
    parse,
    ADAPTER_NAME,
    ADAPTER_VERSION,
};
