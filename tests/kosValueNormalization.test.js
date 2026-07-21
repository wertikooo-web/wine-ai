'use strict';

/**
 * WINE AI KOS - Value Normalization Test Suite (Step 3A Refined)
 */

const assert = require('assert');
const {
    normalizeString,
    normalizeDecimal,
    normalizeInteger,
    normalizeBoolean,
    normalizePercentage,
    normalizeYear,
    normalizeVolume,
    normalizeMoney,
    normalizeUrl,
    normalizeEmail,
    normalizePhone,
    normalizeLanguageTag,
} = require('../src/kos/extraction/normalization/valueNormalizers');

async function run() {
    let assertions = 0;
    const assertEqual = (a, b) => { assertions++; assert.strictEqual(a, b); };
    const assertDeepEqual = (a, b) => { assertions++; assert.deepStrictEqual(a, b); };

    // 1. String Normalization & Unicode (Cyrillic, Romanian, Japanese)
    assertEqual(normalizeString('  Castel   Mimi  \n  '), 'Castel Mimi');
    assertEqual(normalizeString('Винодельня   Молдовы'), 'Винодельня Молдовы');
    assertEqual(normalizeString('Ștefan   cel   Mare'), 'Ștefan cel Mare');
    assertEqual(normalizeString('Fetească   Neagră'), 'Fetească Neagră');
    assertEqual(normalizeString('ワイ  ン'), 'ワイ ン');

    // 2. Decimal Normalization & Ambiguous Locale Rejection
    assertEqual(normalizeDecimal('13.5'), 13.5);
    assertEqual(normalizeDecimal('13,5'), 13.5);
    assertEqual(normalizeDecimal('1.234,50'), null); // Ambiguous mixed locale format rejected!
    assertEqual(normalizeDecimal('1,234.50'), null); // Ambiguous format rejected!

    // 3. Integer & Boolean Normalization
    assertEqual(normalizeInteger('750'), 750);
    assertEqual(normalizeBoolean('true'), true);
    assertEqual(normalizeBoolean('da'), true);
    assertEqual(normalizeBoolean('nu'), false);

    // 4. Percentage Normalization
    assertEqual(normalizePercentage('13,5% vol.'), 13.5);

    // 5. Vintage Year Exact Normalization (Rejects sentence scanning)
    assertEqual(normalizeYear('2019'), 2019);
    assertEqual(normalizeYear(2019), 2019);
    assertEqual(normalizeYear('Anul 2019'), null); // Rejects sentence guessing!

    // 6. Volume Unit Normalization
    assertEqual(normalizeVolume('0,75 L'), 750);
    assertEqual(normalizeVolume('750 ml'), 750);

    // 7. Money Normalization
    assertDeepEqual(normalizeMoney('150 MDL'), { amount: 150, currency: 'MDL' });
    assertDeepEqual(normalizeMoney('€ 25,50'), { amount: 25.5, currency: 'EUR' });

    // 8. URL Normalization (Restricts to http/https)
    assertEqual(normalizeUrl('www.castelmimi.md/'), 'https://www.castelmimi.md');
    assertEqual(normalizeUrl('ftp://example.com'), null); // Rejects non-http/https!

    // 9. Email Normalization
    assertEqual(normalizeEmail(' Info@CastelMimi.MD '), 'Info@castelmimi.md');

    // 10. Phone & Language Tag Normalization
    assertEqual(normalizePhone('+373 22 123-456'), '+37322123456');
    assertEqual(normalizeLanguageTag('RO_MD'), 'ro');

    console.log(`kosValueNormalization.test.js: All ${assertions} assertions passed successfully!`);
    return { assertionCount: assertions };
}

module.exports = { run };
