'use strict';

/**
 * WINE AI KOS - Source Registry Test Suite (Step 2C.1)
 */

const assert = require('assert');
const { createMemoryPgPool } = require('./helpers/postgresMemoryDb');
const { createSource, getSource, findSourceByOrigin, listSources } = require('../src/kos/sources/sourceRegistry');

async function run() {
    let assertions = 0;
    const assertEqual = (a, b) => { assertions++; assert.strictEqual(a, b); };
    const assertOk = (cond) => { assertions++; assert.ok(cond); };

    const pool = createMemoryPgPool();

    // 1. Create Source without Winery (General Industry Portal)
    const source1 = await createSource({
        name: 'Wine of Moldova Official Portal',
        seedUrl: 'https://wineofmoldova.com/en/about-onvv/',
        sourceType: 'industry_portal',
        trustLevel: 'C',
    }, pool);

    assertOk(source1.id.startsWith('src_'));
    assertEqual(source1.name, 'Wine of Moldova Official Portal');
    assertEqual(source1.normalized_origin, 'https://wineofmoldova.com');
    assertEqual(source1.trust_level, 'C');
    assertEqual(source1.winery_id, null);

    // 2. Find Source by Normalized Origin
    const foundOrigin = await findSourceByOrigin('https://wineofmoldova.com', pool);
    assertOk(foundOrigin);
    assertEqual(foundOrigin.id, source1.id);

    // 3. Create Source with Winery Binding
    const source2 = await createSource({
        name: 'Castel Mimi Official Website',
        seedUrl: 'https://wineofmoldova.com/en/our-wineries/', // Valid public host
        sourceType: 'official_website',
        trustLevel: 'A',
        wineryId: 'winery_castel_mimi',
    }, pool);

    assertEqual(source2.winery_id, 'winery_castel_mimi');
    assertEqual(source2.trust_level, 'A');

    // 4. List Sources Filtered by Winery
    const listWinery = await listSources({ wineryId: 'winery_castel_mimi' }, pool);
    assertEqual(listWinery.length, 1);
    assertEqual(listWinery[0].id, source2.id);

    console.log(`kosSourceRegistry.test.js: All ${assertions} assertions passed successfully!`);
    return { assertionCount: assertions };
}

module.exports = { run };
