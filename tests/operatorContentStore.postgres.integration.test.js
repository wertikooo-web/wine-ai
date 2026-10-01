'use strict';

// operator_content on a real PostgreSQL (TEST_DATABASE_URL). Skipped when no
// test database is configured.

const { Pool } = require('pg');
const t = require('./helpers/assertions');
const { createPostgresOperatorContentStore } = require('../src/operatorContent/operatorContentStore');

async function run() {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) { console.log('operatorContentStore.postgres: TEST_DATABASE_URL not set, skipped'); return; }
    const pool = new Pool({ connectionString: url });
    try {
        await pool.query('DROP TABLE IF EXISTS operator_content');
        const store = createPostgresOperatorContentStore(() => pool);
        t.equal(await store.get('news'), null, 'empty: no block (features OFF by default)');
        const first = await store.save({ id: 'news', type: 'news', rawText: 'A', enabled: true, mode: 'on', activeFrom: null, activeUntil: '2030-10-31T21:00:00.000Z', settings: {}, parsed: { items: [{ newsId: 'n1' }] }, updatedBy: 'dashboard' });
        t.equal(first.version, 1); t.equal(first.enabled, true); t.equal(first.activeUntil, '2030-10-31T21:00:00.000Z');
        t.equal(first.parsed.items[0].newsId, 'n1', 'structured representation persisted');
        const second = await store.save({ id: 'news', type: 'news', rawText: 'B', enabled: false, mode: 'off', activeFrom: null, activeUntil: null, settings: {}, parsed: {}, updatedBy: 'dashboard' });
        t.equal(second.version, 2, 'version increments'); t.equal(second.rawText, 'B'); t.equal(second.activeUntil, null);
        t.equal(second.createdAt, first.createdAt, 'created_at kept');
        const rec = await store.save({ id: 'recommendations', type: 'recommendations', rawText: 'R', enabled: true, mode: 'shadow', activeFrom: null, activeUntil: null, settings: { boost: 8 }, parsed: { promotions: [] } });
        t.equal(rec.mode, 'shadow'); t.equal(rec.settings.boost, 8);
        // Rollback of the migration is a single DROP.
        await pool.query('DROP TABLE operator_content');
        const { rows } = await pool.query("SELECT to_regclass('operator_content') AS t");
        t.equal(rows[0].t, null, 'rollback: table dropped');
    } finally {
        await pool.end();
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('operatorContentStore.postgres tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
