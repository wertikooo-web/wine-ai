'use strict';

// Turn journal (src/observability/turnJournal.js): one row per assistant
// turn, observation only. Unit: collector (tools, usage after the turn,
// first audio, cost, empty turns dropped), store, text switch, tool summary.
// End-to-end: a real text turn through the realtime server (mock provider)
// lands in the journal; the conversation is unchanged.

process.env.TURN_JOURNAL_DELAY_MS = '50';
const t = require('./helpers/assertions');
const journal = require('../src/observability/turnJournal');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function unit() {
    let n = 0;
    const ok = (c, m) => { t.ok(c, m); n += 1; };
    const rows = [];
    let clock = 1000;
    const c = journal.createTurnCollector({
        base: { session_id: 's1', channel: 'lite', provider: 'gemini', model: 'gemini-3.1-flash-live-preview', access_grant: 'lac_x' },
        write: (row) => rows.push(row),
        delayMs: 20,
        now: () => clock,
    });
    const gen = { generationId: 'g1', turnId: 't1', createdAt: 1000, mode: 'tap_to_start' };
    c.noteTool({ generationId: 'g1', summary: journal.summarizeToolResult('search_wine_knowledge', { found: true, used_levels: ['canonical', 'documents'], web_used: false, answerable: true, evidence: [{ level: 'documents', chunk_id: 'k1', title: 'Purcari', relevance_score: 0.712345 }, { level: 'canonical', entity_id: 'w:purcari' }] }, 812) });
    clock = 2200;
    c.noteFirstAudio(gen);
    clock = 4000;
    c.finish(gen, { outcome: 'completed', question: ' Что такое   Purcari? ', answer: 'Это винодельня.', language: 'ru', voice: 'Leda' });
    // usage arrives after the turn ended (Gemini reports it at turnComplete)
    c.noteUsage(null, { promptTokenCount: 15000, responseTokenCount: 300, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 14000 }, { modality: 'AUDIO', tokenCount: 1000 }], responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 300 }] }, 'gemini_usage_metadata');
    await sleep(60);
    ok(rows.length === 1, 'one row per turn');
    const row = rows[0];
    ok(row.id === 'g1' && row.session_id === 's1' && row.channel === 'lite' && row.access_grant === 'lac_x', 'base fields');
    ok(row.question === 'Что такое Purcari?' && row.answer === 'Это винодельня.', 'question/answer normalized');
    ok(row.first_audio_ms === 1200 && row.total_ms === 3000, 'latency: first audio and total');
    ok(row.tools.length === 1 && row.tools[0].name === 'search_wine_knowledge' && row.tools[0].ms === 812, 'tool recorded with duration');
    ok(row.tools[0].evidence[0].id === 'k1' && row.tools[0].evidence[0].score === 0.712 && row.tools[0].evidence[1].id === 'w:purcari', 'evidence ids/levels/scores');
    ok(row.usage && row.usage.input_text_tokens === 14000 && row.usage.output_audio_tokens === 300, 'usage that arrived after the turn is attributed to it');
    const expected = (14000 * 0.75 + 1000 * 3 + 300 * 12) / 1e6;
    ok(Math.abs(row.cost_usd - expected) < 1e-9, `cost from list prices (${row.cost_usd})`);

    rows.length = 0;
    c.finish({ generationId: 'g2', createdAt: clock }, { outcome: 'interrupted', question: '', answer: '' });
    await sleep(40);
    ok(rows.length === 0, 'empty turn (no question, answer or tools) is not recorded');

    // Free Conversation: the next generation already exists (idle) when the
    // previous turn's usage arrives at turnComplete
    rows.length = 0;
    const g4 = { generationId: 'g4', createdAt: clock };
    c.finish(g4, { outcome: 'completed', question: 'Q', answer: 'A' });
    const g5 = { generationId: 'g5', createdAt: clock };
    c.touch(g5);
    c.noteUsage(g5, { promptTokenCount: 100, responseTokenCount: 10, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 100 }], responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 10 }] }, 'gemini_usage_metadata');
    await sleep(40);
    ok(rows.length === 1 && rows[0].id === 'g4' && rows[0].usage && rows[0].usage.input_text_tokens === 100, 'late usage goes to the turn that just ended, not the idle next one');

    const store = journal.createMemoryTurnStore();
    journal.recordTurn({ ...row, id: 'g9' }, { store, env: { TURN_JOURNAL_TEXT: 'off' } });
    journal.recordTurn({ ...row, id: 'g10' }, { store, env: { TURN_JOURNAL: 'off' } });
    await sleep(10);
    ok(store._rows.length === 1 && store._rows[0].question === null && store._rows[0].answer === null, 'TURN_JOURNAL_TEXT=off drops text; TURN_JOURNAL=off records nothing');
    ok(journal.retentionDays({}) === 30 && journal.retentionDays({ TURN_JOURNAL_RETENTION_DAYS: '7' }) === 7, 'retention');

    let observed = null;
    const wrapped = journal.observeToolHandlers({ x: async () => ({ found: false, error: 'boom' }) }, (r) => { observed = r; });
    const out = await wrapped.x({ generationId: 'g3' });
    ok(out.error === 'boom' && observed.generationId === 'g3' && observed.summary.ok === false, 'tool observer is transparent');
    return n;
}

async function endToEnd() {
    const { startTestServer } = require('./helpers/testServer');
    const { connect } = require('./helpers/wsTestClient');
    const store = journal.getTurnStore();
    const before = store._rows ? store._rows.length : 0;
    const { port, close } = await startTestServer();
    const client = await connect(port, '/realtime');
    try {
        await client.waitFor((e) => e.type === 'session.ready');
        client.sendJson({ type: 'session.start', sampleRate: 16000 });
        await client.waitFor((e) => e.type === 'session.config.applied', { timeoutMs: 5000 });
        client.sendJson({ type: 'input_text.submit', text: 'Какое вино к рыбе?' });
        const end = await client.waitFor((e) => e.type === 'audio.end', { timeoutMs: 8000, label: 'audio.end' });
        t.ok(end, 'the conversation completes as before');
        await sleep(300);
        const rows = store._rows ? store._rows.slice(before) : [];
        t.ok(rows.length === 1, `one journal row for the text turn (${rows.length})`);
        t.ok(rows[0].question === 'Какое вино к рыбе?' && /Mock response/.test(rows[0].answer || '') && rows[0].outcome === 'completed' && rows[0].mode === 'text', 'question, answer, outcome, mode');
    } finally {
        client.close();
        await close();
    }
    return 3;
}

async function run() {
    const a = await unit();
    const b = await endToEnd();
    return { assertionCount: a + b };
}

module.exports = { run };

if (require.main === module) {
    run().then((r) => { console.log(`turnJournal passed (${r.assertionCount})`); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
