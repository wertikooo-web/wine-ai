'use strict';

/**
 * WINE AI KOS - Plain Text Format Adapter (Step 2C.4)
 *
 * Parses UTF-8 / BOM plain text files into paragraph blocks.
 */

const { normalizeText } = require('../parsedDocumentBuilder');

const ADAPTER_NAME = 'text_adapter';
const ADAPTER_VERSION = '1.0.0';

async function parse({ rawBody }) {
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
        throw Object.assign(new Error('KOS_TEXT_PARSE_BUFFER_REQUIRED'), { code: 'KOS_TEXT_PARSE_BUFFER_REQUIRED' });
    }

    let text = rawBody.toString('utf8');
    // Strip UTF-8 BOM if present (\uFEFF)
    if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
    }

    const normalized = normalizeText(text);
    if (!normalized) {
        return {
            title: '',
            blocks: [],
            warnings: ['Empty text file'],
        };
    }

    // Split paragraphs by blank lines (\n\n+)
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
