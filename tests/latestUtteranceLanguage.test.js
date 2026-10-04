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

        // Typed input: a clear switch is applied before THIS turn's answer.
        const from = client.events ? client.events.length : 0;
        client.sendJson({ type: 'input_text.submit', text: 'А какое розовое вино из Молдовы вы мне посоветуете попробовать?' });
        const sw = await client.waitFor((e) => e.type === 'language.switch_detected', { timeoutMs: 5000, label: 'switch' });
        const rotated = await client.waitFor((e) => e.type === 'provider.rotated' && e.reason === 'language_switch', { timeoutMs: 5000, label: 'rotation' });
        const audio = await client.waitFor((e) => e.type === 'audio.start', { timeoutMs: 8000, label: 'audio.start' });
        t.ok(sw && sw.from_language === 'ro' && sw.to_language === 'ru', 'typed Russian after Romanian switches the language');
        t.ok(rotated && audio && rotated.server_time_ms <= audio.server_time_ms, 'rotation happens before this turn answers');
        void from;
    } finally {
        client.close();
        await close();
    }
    return { assertionCount: 5 };
}

module.exports = { run };

if (require.main === module) {
    run().then((r) => { console.log(`latestUtteranceLanguage passed (${r.assertionCount})`); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
