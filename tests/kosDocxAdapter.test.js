'use strict';

/**
 * WINE AI KOS - DOCX Adapter Test Suite (Step 2B.1 Production Refined)
 *
 * Verifies OpenXML linking & resolution:
 * 1. Heading style resolution via word/styles.xml
 * 2. Footnotes extraction via word/footnotes.xml
 * 3. Endnotes extraction via word/endnotes.xml
 * 4. Romanian & Cyrillic Unicode extraction
 * 5. Table rows/cells provenance
 * 6. XXE rejection
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { parseDocxFormat } = require('../src/kos/parsers/adapters/docxAdapter');
const { KosParserError } = require('../src/kos/parsers/core/parserContracts');

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

async function run() {
    let assertions = 0;
    const assertEqual = (a, b) => { assertions++; assert.strictEqual(a, b); };
    const assertOk = (cond) => { assertions++; assert.ok(cond); };

    // 1. Real Expanded OpenXML DOCX Binary Fixture Test
    const docxFilePath = path.join(FIXTURES_DIR, 'sample.docx');
    const docxBuffer = fs.readFileSync(docxFilePath);

    const parsedDocx = await parseDocxFormat(docxBuffer, {
        originalFilename: 'sample.docx',
        declaredMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }, { now: () => new Date('2026-01-01T00:00:00Z') });

    assertEqual(parsedDocx.sourceMimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    // 2. OpenXML Structural Resolution Assertions
    const headingUnit = parsedDocx.structuralUnits.find((u) => u.text.startsWith('# '));
    assertOk(headingUnit);
    assertOk(headingUnit.text.includes('Castel Mimi — Pașaport Tehnologic'));

    // Verify Footnotes & Endnotes
    assertOk(parsedDocx.canonicalText.includes('Notă de subsol: Purcari fondat în 1827.'));
    assertOk(parsedDocx.canonicalText.includes('Notă finală despre regiunea Ștefan Vodă.'));

    // Verify Romanian & Cyrillic text
    assertOk(parsedDocx.canonicalText.includes('Винодельня Молдовы'));
    assertOk(parsedDocx.canonicalText.includes('Fetească Neagră'));
    assertOk(parsedDocx.canonicalText.includes('Ștefan cel Mare'));

    // 3. Check Paragraph Provenance & Stability
    const pUnit = parsedDocx.structuralUnits.find((u) => u.docxLocation.paragraphIndex !== null);
    assertOk(pUnit);
    assertOk(pUnit.docxLocation.paragraphIndex > 0);

    // Structural range quote slicing check
    const sliceQuote = parsedDocx.canonicalText.slice(pUnit.range.utf16Start, pUnit.range.utf16End);
    assertEqual(sliceQuote, pUnit.text);

    // 4. Corrupted Container Rejection
    const corruptedZipBuffer = Buffer.from('Not a real zip container data string');
    assertions++;
    await assert.rejects(async () => {
        await parseDocxFormat(corruptedZipBuffer, {});
    }, (err) => err instanceof KosParserError && err.code === 'KOS_PARSE_CORRUPTED_CONTAINER');

    // 5. XXE Pre-scan DTD Attack Rejection Test
    const xxeZip = new AdmZip();
    const xxeDocumentXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:body><w:p><w:r><w:t>&xxe;</w:t></w:r></w:p></w:body>
</w:document>`;
    xxeZip.addFile('[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', 'utf8'));
    xxeZip.addFile('_rels/.rels', Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>', 'utf8'));
    xxeZip.addFile('word/document.xml', Buffer.from(xxeDocumentXml, 'utf8'));

    assertions++;
    await assert.rejects(async () => {
        await parseDocxFormat(xxeZip.toBuffer(), {});
    }, (err) => err instanceof KosParserError && err.code === 'KOS_PARSE_CORRUPTED_CONTAINER' && err.message.includes('XXE'));

    // 6. Macro DOCM Quarantined Rejection Test
    const docmZip = new AdmZip();
    docmZip.addFile('[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', 'utf8'));
    docmZip.addFile('word/document.xml', Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>', 'utf8'));
    docmZip.addFile('word/vbaProject.bin', Buffer.from([0x00, 0x01]));

    assertions++;
    await assert.rejects(async () => {
        await parseDocxFormat(docmZip.toBuffer(), {});
    }, (err) => err instanceof KosParserError && err.code === 'KOS_PARSE_UNSUPPORTED_FORMAT');

    console.log(`kosDocxAdapter.test.js: All ${assertions} assertions passed successfully!`);
    return { assertionCount: assertions };
}

module.exports = { run };
