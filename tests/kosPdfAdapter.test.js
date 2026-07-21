'use strict';

/**
 * WINE AI KOS - PDF Adapter Test Suite (Step 2B.1 Production Refined)
 *
 * Verifies:
 * 1. True Romanian Unicode extraction ("Ștefan cel Mare", "Fetească Neagră")
 * 2. True Cyrillic Unicode extraction ("винодельня", "Молдовы")
 * 3. Item-level structural provenance from PDF.js (pageNumber, itemStartIndex, transform, width, height, fontName)
 * 4. Range quote slicing equality
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parsePdfFormat } = require('../src/kos/parsers/adapters/pdfAdapter');
const { KosParserError } = require('../src/kos/parsers/core/parserContracts');

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

async function run() {
    let assertions = 0;
    const assertEqual = (a, b) => { assertions++; assert.strictEqual(a, b); };
    const assertOk = (cond) => { assertions++; assert.ok(cond); };
    const assertDeepEqual = (a, b) => { assertions++; assert.deepStrictEqual(a, b); };

    // 1. Real PDF Binary Fixture Test
    const pdfFilePath = path.join(FIXTURES_DIR, 'sample.pdf');
    const pdfBuffer = fs.readFileSync(pdfFilePath);

    const parsedPdf = await parsePdfFormat(pdfBuffer, {
        originalFilename: 'sample.pdf',
        declaredMimeType: 'application/pdf',
    }, { now: () => new Date('2026-01-01T00:00:00Z') });

    assertEqual(parsedPdf.sourceMimeType, 'application/pdf');

    // 2. True Romanian & Cyrillic Unicode Extraction Assertions
    assertOk(parsedPdf.canonicalText.includes('Fetească Neagră'));
    assertOk(parsedPdf.canonicalText.includes('Ștefan cel Mare'));
    assertOk(parsedPdf.canonicalText.includes('винодельня'));
    assertOk(parsedPdf.canonicalText.includes('Молдовы'));

    // 3. Item-level Structural Provenance Assertions
    const unit = parsedPdf.structuralUnits.find((item) => item.text.includes('Fetească'));
    assertOk(unit);
    assertEqual(unit.pdfLocation.pageNumber, 1);
    assertOk(Number.isInteger(unit.pdfLocation.itemStartIndex));
    assertOk(unit.pdfLocation.itemStartIndex >= 0);
    assertOk(Array.isArray(unit.pdfLocation.transform));
    assertOk(unit.pdfLocation.transform.length === 6);
    assertOk(typeof unit.pdfLocation.width === 'number');
    assertOk(typeof unit.pdfLocation.height === 'number');
    assertOk(typeof unit.pdfLocation.fontName === 'string');

    // Canonical range quote slicing check
    const sliceQuote = parsedPdf.canonicalText.slice(unit.range.utf16Start, unit.range.utf16End);
    assertEqual(sliceQuote, unit.text);

    // 4. Encrypted PDF Rejection
    const encryptedPdfBuffer = Buffer.from('%PDF-1.4 /Type /Page /Encrypt 1 0 R %%EOF');
    assertions++;
    await assert.rejects(async () => {
        await parsePdfFormat(encryptedPdfBuffer, {});
    }, (err) => err instanceof KosParserError && err.code === 'KOS_PARSE_ENCRYPTED_PDF');

    // 5. Empty PDF Source Rejection
    assertions++;
    await assert.rejects(async () => {
        await parsePdfFormat(Buffer.alloc(0), {});
    }, (err) => err instanceof KosParserError && err.code === 'KOS_PARSE_EMPTY_SOURCE');

    console.log(`kosPdfAdapter.test.js: All ${assertions} assertions passed successfully!`);
    return { assertionCount: assertions };
}

module.exports = { run };
