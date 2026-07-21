'use strict';

/**
 * WINE AI KOS - HTML Adapter Test Suite (Step 2B.1 Production)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseHtmlFormat } = require('../src/kos/parsers/adapters/htmlAdapter');

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

async function run() {
    let assertions = 0;
    const assertEqual = (a, b) => { assertions++; assert.strictEqual(a, b); };
    const assertOk = (cond) => { assertions++; assert.ok(cond); };

    const htmlFilePath = path.join(FIXTURES_DIR, 'sample.html');
    const htmlBuffer = fs.readFileSync(htmlFilePath);

    const parsedHtml = await parseHtmlFormat(htmlBuffer, {
        originalFilename: 'sample.html',
        declaredMimeType: 'text/html',
    }, { now: () => new Date('2026-01-01T00:00:00Z') });

    assertEqual(parsedHtml.sourceMimeType, 'text/html');
    assertOk(parsedHtml.canonicalText.includes('Castel Mimi SRL'));
    assertEqual(parsedHtml.canonicalText.includes('<script>'), false);
    assertOk(parsedHtml.transformations.some((t) => t.code === 'html_script_elements_excluded'));

    // Check Structural Provenance
    assertOk(parsedHtml.structuralUnits.length > 0);
    const unit = parsedHtml.structuralUnits[0];
    assertOk(unit.htmlLocation.nodeIndex > 0);
    assertEqual(unit.htmlLocation.sourceLocationStatus, 'not_available');

    // Structural range quote slicing check
    const sliceQuote = parsedHtml.canonicalText.slice(unit.range.utf16Start, unit.range.utf16End);
    assertEqual(sliceQuote, unit.text);

    // Capability check: expected transformations do NOT force partial capability if no text is lost
    assertEqual(parsedHtml.parserCapability, 'full');

    console.log(`kosHtmlAdapter.test.js: All ${assertions} assertions passed successfully!`);
    return { assertionCount: assertions };
}

module.exports = { run };
