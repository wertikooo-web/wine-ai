'use strict';

// Test Control store against a REAL PostgreSQL (TEST_DATABASE_URL or
// DATABASE_URL): schema, atomic publish with increasing revisions, history,
// presets/baseline, sessions, feedback, and a service "restart" that reloads
// the published config from the database. Skips on the in-memory sentinel.

const t = require('./helpers/assertions');

async function run() {
    const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
    if (!url || url === 'memory') {
        console.log('skip: liveTestStore.postgres.integration needs TEST_DATABASE_URL');
        return;
    }
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url });
    const { createPostgresLiveTestStore, createLiveTestService, SEED_PRESETS } = require('../src/liveTest/liveTestConfig');
    try {
        await pool.query('DROP TABLE IF EXISTS live_test_state, live_test_revisions, live_test_sessions, live_test_feedback');
        const store = createPostgresLiveTestStore(() => pool);
        const service = createLiveTestService({ store, log: () => {} });
        await service.load();
        t.equal(service.getPublished(), null, 'empty database: nothing published');

        const [p1, p2] = await Promise.all([service.publish(SEED_PRESETS.A.config, 'A'), service.publish(SEED_PRESETS.C.config, 'C')]);
        t.deepEqual([p1.published.revision, p2.published.revision].sort(), [1, 2], 'concurrent publishes get distinct revisions');
        const history = await store.listRevisions();
        t.equal(history.length, 2, 'two history rows');
        t.equal(history[0].revision, 2, 'history newest first');

        await service.savePreset('A', 'Custom', SEED_PRESETS.D.config);
        await service.saveBaseline(SEED_PRESETS.B.config);

        const restarted = createLiveTestService({ store: createPostgresLiveTestStore(() => pool), log: () => {} });
        await restarted.load();
        t.equal(restarted.getPublished().revision, 2, 'published revision reloaded from PostgreSQL after restart');
        t.equal((await restarted.getPresets()).A.label, 'Custom', 'preset persisted');
        t.deepEqual((await restarted.getBaseline()).config, SEED_PRESETS.B.config, 'baseline persisted');

        const snapshot = restarted.snapshotForNewSession();
        await store.recordSession({ session_id: 'session_abc123def456', started_at: new Date().toISOString(), config_revision: snapshot.revision, snapshot: { ...snapshot.config } });
        await store.recordSession({ session_id: 'session_abc123def456', started_at: new Date().toISOString(), config_revision: 99, snapshot: {} });
        await store.closeSession({ session_id: 'session_abc123def456', language: 'ro', ended_at: new Date().toISOString() });
        const sessions = await store.listSessions();
        t.equal(sessions.length, 1, 'session recorded once (idempotent)');
        t.equal(sessions[0].config_revision, snapshot.revision, 'first snapshot wins');
        t.equal(sessions[0].language, 'ro', 'language recorded at close');
        await store.addFeedback({ session_id: 'session_abc123def456', conversation_score: 4, voice_score: 5, comment: 'bine', config_revision: snapshot.revision });
        const feedback = await store.listFeedback();
        t.equal(feedback[0].voice_score, 5, 'feedback persisted');
    } finally {
        await pool.end();
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('liveTestStore postgres integration passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
