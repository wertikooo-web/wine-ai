'use strict';

/**
 * WINE AI KOS - Heading Context & Tree Navigation Test Suite (Step 3B Production)
 */

const assert = require('assert');
const { buildProvisionalKey, findNearestHeadingContext } = require('../src/kos/extraction/deterministic/context/headingContext');

async function run() {
    let assertions = 0;
    const assertEqual = (a, b) => { assertions++; assert.strictEqual(a, b); };
    const assertOk = (cond) => { assertions++; assert.ok(cond); };

    // 1. Provisional Key Generation
    assertEqual(buildProvisionalKey('Castel Mimi Governor 2019'), 'castel-mimi-governor-2019');
    assertEqual(buildProvisionalKey('Vinăria  Purcari — Roșu de Purcari!'), 'vinăria-purcari-roșu-de-purcari');
    assertEqual(buildProvisionalKey(''), 'provisional-entity');

    // 2. Heading Tree Hierarchy Test Structure:
    // # Winery
    // ## Wine A
    // Alcool: 13%
    // ### Technical details
    // Volum: 750 ml
    // ## Wine B
    // Alcool: 14%
    const units = [
        { id: 'u_0', text: '# Winery' },
        { id: 'u_1', text: '## Wine A' },
        { id: 'u_2', text: 'Alcool: 13%' },
        { id: 'u_3', text: '### Technical details' },
        { id: 'u_4', text: 'Volum: 750 ml' },
        { id: 'u_5', text: '## Wine B' },
        { id: 'u_6', text: 'Alcool: 14%' },
    ];

    // u_2 (Alcool: 13%) -> Wine A
    const ctx2 = findNearestHeadingContext(units, 2);
    assertOk(ctx2);
    assertEqual(ctx2.provisionalKey, 'wine-a');
    assertEqual(ctx2.level, 2);

    // u_4 (Volum: 750 ml) inside ### Technical details -> Technical details child heading
    const ctx4 = findNearestHeadingContext(units, 4);
    assertOk(ctx4);
    assertEqual(ctx4.provisionalKey, 'technical-details');
    assertEqual(ctx4.level, 3);

    // u_6 (Alcool: 14%) -> Wine B clears Wine A & Technical details
    const ctx6 = findNearestHeadingContext(units, 6);
    assertOk(ctx6);
    assertEqual(ctx6.provisionalKey, 'wine-b');
    assertEqual(ctx6.level, 2);

    // 3. Distance Guard Test (Exceeding maxDistance of 3 units)
    const longUnits = [
        { id: 'u_0', text: '## Long Ago Wine' },
        { id: 'u_1', text: 'Text 1' },
        { id: 'u_2', text: 'Text 2' },
        { id: 'u_3', text: 'Text 3' },
        { id: 'u_4', text: 'Text 4' },
    ];
    const ctxFar = findNearestHeadingContext(longUnits, 4, { maxDistance: 3 });
    assertEqual(ctxFar, null); // Exceeds maxDistance -> context cleared!

    console.log(`kosHeadingContext.test.js: All ${assertions} assertions passed successfully!`);
    return { assertionCount: assertions };
}

module.exports = { run };
