'use strict';

/**
 * WINE AI KOS - Extractor Registry & Content-Sensitive Fingerprint Test Suite (Step 3B Production)
 */

const assert = require('assert');
const { getRegisteredExtractors, getExtractorRegistryFingerprint } = require('../src/kos/extraction/deterministic/extractorRegistry');
const { WINE_LABELS } = require('../src/kos/extraction/deterministic/dictionaries/wineLabels');

async function run() {
    let assertions = 0;
    const assertEqual = (a, b) => { assertions++; assert.strictEqual(a, b); };
    const assertOk = (cond) => { assertions++; assert.ok(cond); };

    const extractors = getRegisteredExtractors();
    assertOk(extractors.length >= 3);

    const fp1 = getExtractorRegistryFingerprint();
    const fp2 = getExtractorRegistryFingerprint();

    // 1. Length & Deterministic Consistency
    assertEqual(fp1.length, 64);
    assertEqual(fp1, fp2);

    // 2. Content Sensitivity Test (Modifying label text WITHOUT changing version string MUST change fingerprint)
    const modifiedWineLabels = JSON.parse(JSON.stringify(WINE_LABELS));
    modifiedWineLabels['wine.alcoholPercent'].labels.ro.push('tărie alcoolică nouă');

    const fpModified = getExtractorRegistryFingerprint(modifiedWineLabels);
    assertOk(fp1 !== fpModified); // Content change detected!

    console.log(`kosExtractorRegistry.test.js: All ${assertions} assertions passed successfully!`);
    return { assertionCount: assertions };
}

module.exports = { run };
