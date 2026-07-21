'use strict';

/**
 * WINE AI KOS - ReDoS Safety Test Suite (Step 3B Production)
 */

const assert = require('assert');
const { extractLabelValuePairs } = require('../src/kos/extraction/deterministic/extractors/labelValueExtractor');

async function run() {
    let assertions = 0;
    const assertEqual = (a, b) => { assertions++; assert.strictEqual(a, b); };
    const assertOk = (cond) => { assertions++; assert.ok(cond); };

    // 1. Adversarial long repeating strings (50,000 characters)
    const longAdversarialText = 'Alcool ' + 'a'.repeat(50000) + ' 13.5%';

    const parsedDoc = {
        sourceId: 'src_redos',
        sourceChecksum: 'chk_redos',
        documentFingerprint: 'doc_fp_redos',
        canonicalText: longAdversarialText,
        structuralUnits: [{ id: 'u_redos', text: longAdversarialText, range: { utf16Start: 0, utf16End: longAdversarialText.length } }],
    };

    const start = Date.now();
    const { drafts } = extractLabelValuePairs(parsedDoc);
    const duration = Date.now() - start;

    // Must complete under 100ms without catastrophic ReDoS backtracking
    assertOk(duration < 100);
    assertEqual(Array.isArray(drafts), true);

    console.log(`kosRegexSafety.test.js: All ${assertions} assertions passed in ${duration}ms!`);
    return { assertionCount: assertions };
}

module.exports = { run };
