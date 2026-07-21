'use strict';

/**
 * WINE AI KOS - HTML Format Adapter (Step 2C.4)
 *
 * Parses HTML document markup using Cheerio:
 * - Strips `<script>`, `<style>`, `<noscript>`, `<iframe>`, `<header>`, `<footer>`, `<nav>`
 * - Extracts document title
 * - Extracts headings (h1..h6), paragraphs, list items, and table rows into blocks
 */

const cheerio = require('cheerio');
const { normalizeText } = require('../parsedDocumentBuilder');

const ADAPTER_NAME = 'html_adapter';
const ADAPTER_VERSION = '1.0.0';

async function parse({ rawBody }) {
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
        throw Object.assign(new Error('KOS_HTML_PARSE_BUFFER_REQUIRED'), { code: 'KOS_HTML_PARSE_BUFFER_REQUIRED' });
    }

    const htmlString = rawBody.toString('utf8');
    const $ = cheerio.load(htmlString);

    // Remove non-content elements
    $('script, style, noscript, iframe, svg').remove();

    // Extract title
    let title = normalizeText($('title').first().text());
    if (!title) {
        title = normalizeText($('h1').first().text());
    }

    const blocks = [];
    const warnings = [];

    // Traverse structural elements in body
    $('body, html').find('h1, h2, h3, h4, h5, h6, p, li, tr').each((_, el) => {
        const tagName = el.tagName.toLowerCase();
        const rawText = $(el).text();
        const text = normalizeText(rawText);

        if (!text) return;

        if (/^h[1-6]$/.test(tagName)) {
            const level = parseInt(tagName.charAt(1), 10);
            blocks.push({
                type: 'heading',
                text,
                headingLevel: level,
            });
        } else if (tagName === 'li') {
            blocks.push({
                type: 'list_item',
                text,
            });
        } else if (tagName === 'tr') {
            const cellTexts = [];
            $(el).find('th, td').each((_, cell) => {
                const cellText = normalizeText($(cell).text());
                if (cellText) cellTexts.push(cellText);
            });
            if (cellTexts.length > 0) {
                blocks.push({
                    type: 'table_row',
                    text: cellTexts.join(' | '),
                });
            }
        } else if (tagName === 'p') {
            // Avoid duplicate text if paragraph contains headings or list items already visited
            blocks.push({
                type: 'paragraph',
                text,
            });
        }
    });

    // Fallback if no block elements matched
    if (blocks.length === 0) {
        const bodyText = normalizeText($('body').text() || $.text());
        if (bodyText) {
            blocks.push({
                type: 'paragraph',
                text: bodyText,
            });
        } else {
            warnings.push('HTML document contained no extractable text content');
        }
    }

    return {
        title: title || '',
        blocks,
        warnings,
    };
}

module.exports = {
    parse,
    ADAPTER_NAME,
    ADAPTER_VERSION,
};
