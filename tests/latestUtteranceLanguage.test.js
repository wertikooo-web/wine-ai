'use strict';

// Regression (prod, ai_turns): after RU -> RO -> RU the guest's Russian
// question got a Romanian answer. The current-context line said "Continue in
// the last clearly understood language: ro" while the rotation that updates
// the session language only happens before the next turn. The line must
// tell the model that the latest utterance decides the answer language.

const t = require('./helpers/assertions');

async function run() {
    const { startTestServer } = require('./helpers/testServer');
    const { connect } = require('./helpers/wsTestClient');
    const { port, close } = await startTestServer();
    const client = await connect(port, '/realtime');
    try {
        await client.waitFor((e) => e.type === 'session.ready');
        client.sendJson({ type: 'session.start', sampleRate: 16000, language: 'ro', include_prompt_debug: true });
        const applied = await client.waitFor((e) => e.type === 'session.config.applied', { timeoutMs: 5000 });
        const ctx = String(applied.prompt_debug && applied.prompt_debug.current_context || '');
        t.ok(/latest utterance/.test(ctx) && /switch with them in this answer/.test(ctx), 'latest utterance decides the answer language');
        t.ok(!/Continue in the last clearly understood language/.test(ctx), 'no "continue in <old language>" instruction');
        t.ok(/Stay in ro only when the latest utterance is unclear/.test(ctx), 'session language kept only for unclear utterances');
    } finally {
        client.close();
        await close();
    }
    return { assertionCount: 3 };
}

module.exports = { run };

if (require.main === module) {
    run().then((r) => { console.log(`latestUtteranceLanguage passed (${r.assertionCount})`); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
