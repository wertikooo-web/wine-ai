'use strict';

// Visual Companion catalog store against a REAL PostgreSQL
// (TEST_DATABASE_URL or DATABASE_URL). Skips on the in-memory sentinel.

const t = require('./helpers/assertions');

async function run() {
    const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
    if (!url || url === 'memory') {
        console.log('skip: companionStore.postgres.integration needs TEST_DATABASE_URL');
        return;
    }
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url });
    const { createPostgresCompanionStore, validateRecord, publicCard } = require('../src/companion/companionCatalog');
    try {
        await pool.query('DROP TABLE IF EXISTS companion_wines');
        const store = createPostgresCompanionStore(() => pool);
        const { record } = validateRecord({ externalId: 'WMD-9', wineryName: 'Crama X', wineName: 'Rară Neagră Classic', vintage: 2021, productUrl: 'https://winemd.md/p/9' });
        await store.upsert(record, { published: true, source: 'test' });
        await store.upsert({ ...record, shortDescription: 'updated' }, { published: true, source: 'test' });
        const list = await store.list();
        t.equal(list.length, 1, 're-import upserts by wine id');
        t.equal(list[0].shortDescription, 'updated', 'record updated');
        t.equal(publicCard(await store.get(record.wineId)).ctas[0].url, 'https://winemd.md/p/9', 'card with verified CTA from PostgreSQL');
        t.ok(await store.setPublished(record.wineId, false), 'unpublish');
        t.equal(await store.get(record.wineId), null, 'unpublished wine not served');
        t.equal((await store.list()).length, 0, 'unpublished wine not listed');
        t.equal((await store.list({ publishedOnly: false })).length, 1, 'operator list still sees it');
    } finally {
        await pool.end();
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('companionStore postgres integration passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
