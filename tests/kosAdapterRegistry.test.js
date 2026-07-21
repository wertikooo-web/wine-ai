'use strict';

/**
 * WINE AI KOS - Adapter Registry Test Suite (Step 2B.1 Production)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseDocument, detectFormatFromMagicBytes } = require('../src/kos/parsers/adapters/adapterRegistry');
const { createParserFingerprint, KosParserError } = require('../src/kos/parsers/core/parserContracts');

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

async function run() {
    let assertions = 0;
    const assertEqual = (a, b) => { assertions++; assert.strictEqual(a, b); };
    const assertOk = (cond) => { assertions++; assert.ok(cond); };

    const pdfBuffer = fs.readFileSync(path.join(FIXTURES_DIR, 'sample.pdf'));

    // 1. Magic Bytes Format Detection
    const magicFormat = detectFormatFromMagicBytes(pdfBuffer);
    assertEqual(magicFormat, 'pdf');

    // 2. Format Declaration Mismatch (PDF buffer + declared MIME text/html) -> Emits warning, uses PDF adapter
    const registeredResult = await parseDocument(pdfBuffer, {
        originalFilename: 'mismatched.html',
        declaredMimeType: 'text/html',
    }, { useWorker: false, now: () => new Date('2026-01-01T00:00:00Z') });

    assertEqual(registeredResult.sourceMimeType, 'application/pdf');
    assertOk(registeredResult.warnings.some((w) => w.code === 'KOS_FORMAT_DECLARATION_MISMATCH'));

    // 3. Parser Fingerprint Generator
    const fingerprint = createParserFingerprint(registeredResult);
    assertEqual(fingerprint.length, 64);

    // 4. Hard Worker Timeout Verification (timeoutMs: 0 forces KOS_PARSE_TIMEOUT)
    const slowBuffer = Buffer.from('Simple text payload');
    assertions++;
    await assert.rejects(async () => {
        await parseDocument(slowBuffer, {}, { timeoutMs: 0, now: () => new Date('2026-01-01T00:00:00Z') });
    }, (err) => err instanceof KosParserError && err.code === 'KOS_PARSE_TIMEOUT');

    console.log(`kosAdapterRegistry.test.js: All ${assertions} assertions passed successfully!`);
    return { assertionCount: assertions };
}

module.exports = { run };
