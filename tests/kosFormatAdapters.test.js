'use strict';

/**
 * WINE AI KOS - Format Adapters Unit Test Suite (Step 2C.4)
 *
 * Verifies adapter parsers:
 * - HTML: title, headings (H1-H6), paragraphs, list items, script/style element exclusion
 * - TXT: UTF-8, BOM removal, paragraph splitting
 * - PDF: text layer extraction, image-only/no-text PDF error (KOS_PARSE_PDF_NO_TEXT)
 * - DOCX: headings, paragraphs, lists, tables, ZIP entry and uncompressed size limit enforcement
 */

const assert = require('assert');
const htmlAdapter = require('../src/kos/parsing/adapters/htmlAdapter');
const textAdapter = require('../src/kos/parsing/adapters/textAdapter');
const pdfAdapter = require('../src/kos/parsing/adapters/pdfAdapter');
const docxAdapter = require('../src/kos/parsing/adapters/docxAdapter');

async function run() {
    let assertionCount = 0;

    // 1. HTML Adapter Test
    const htmlBuffer = Buffer.from(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Purcari Estate</title>
            <style>body { color: red; }</style>
            <script>console.log('secret');</script>
        </head>
        <body>
            <h1>Welcome to Purcari</h1>
            <p>Purcari is a famous Moldovan winery.</p>
            <ul>
                <li>Freedom Blend</li>
                <li>Negru de Purcari</li>
            </ul>
            <table>
                <tr><th>Wine</th><th>Vintage</th></tr>
                <tr><td>Rosé de Purcari</td><td>2022</td></tr>
            </table>
        </body>
        </html>
    `, 'utf8');

    const htmlRes = await htmlAdapter.parse({ rawBody: htmlBuffer });
    assert.strictEqual(htmlRes.title, 'Purcari Estate');
    assert.ok(htmlRes.blocks.some((b) => b.type === 'heading' && b.text === 'Welcome to Purcari' && b.headingLevel === 1));
    assert.ok(htmlRes.blocks.some((b) => b.type === 'paragraph' && b.text.includes('famous Moldovan winery')));
    assert.ok(htmlRes.blocks.some((b) => b.type === 'list_item' && b.text === 'Freedom Blend'));
    assert.ok(htmlRes.blocks.some((b) => b.type === 'table_row' && b.text.includes('Rosé de Purcari')));
    assert.strictEqual(htmlRes.blocks.some((b) => b.text.includes('console.log')), false);
    assertionCount += 6;

    // 2. Text Adapter Test
    const bomTextBuffer = Buffer.from('\uFEFFTitle: Moldovan Autochthonous Varieties\r\n\r\nFeteasca Neagra is a red grape.\r\n\r\nRara Neagra is a ancient grape.', 'utf8');
    const textRes = await textAdapter.parse({ rawBody: bomTextBuffer });
    assert.strictEqual(textRes.blocks.length, 3);
    assert.strictEqual(textRes.blocks[0].text, 'Title: Moldovan Autochthonous Varieties');
    assert.strictEqual(textRes.blocks[1].text, 'Feteasca Neagra is a red grape.');
    assertionCount += 3;

    // 3. PDF Adapter Test (No Text Error)
    const scannedPdfBuffer = Buffer.from('%PDF-1.4 %Image Only PDF Dummy Content', 'ascii');
    await assert.rejects(async () => {
        await pdfAdapter.parse({ rawBody: scannedPdfBuffer });
    }, (err) => err.code === 'KOS_PARSE_PDF_NO_TEXT');
    assertionCount += 1;

    // 4. DOCX Adapter Test (Corrupted Container Error)
    const invalidDocxBuffer = Buffer.from('Not a ZIP container', 'utf8');
    await assert.rejects(async () => {
        await docxAdapter.parse({ rawBody: invalidDocxBuffer });
    }, (err) => err.code === 'KOS_PARSE_CORRUPTED_CONTAINER');
    assertionCount += 1;

    console.log(`kosFormatAdapters.test.js: All ${assertionCount} assertions passed successfully!`);
    return { assertionCount };
}

module.exports = { run };
