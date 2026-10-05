'use strict';

// A tool call the model SAID ("call:search_wine_knowledge{query:...}") must
// not reach the chat (prod 2026-10-05, /lite screenshot). Unit: streamed
// fragments, nested braces, ordinary "call" words kept. End-to-end: the mock
// provider echoes the question, so a question containing the pattern
// produces an answer transcript that must arrive without it.

const t = require('./helpers/assertions');
const { createToolTextFilter } = require('../src/realtime/toolTextFilter');

function run1(frags) {
    const f = createToolTextFilter();
    return frags.map((x) => f.push(x)).join('') + f.flush();
}

async function run() {
    let n = 0;
    const ok = (c, m) => { t.ok(c, m); n += 1; };
    ok(run1(['call:search_wine_knowledge{query:самый скандальный случай}Я, как твой винный гид, предпочитаю']) === 'Я, как твой винный гид, предпочитаю', 'whole call removed');
    ok(run1(['call:search_', 'wine_knowledge{query:самый ', 'случай}', 'Я, как твой гид']) === 'Я, как твой гид', 'call split across fragments removed');
    ok(run1(['Привет! ca', 'll:show_links{a:{b:1}} Ссылки в чате.']) === 'Привет!  Ссылки в чате.', 'nested braces, split start');
    ok(run1(['I will call', ' you later.']) === 'I will call you later.', 'the word "call" is kept');
    ok(run1(['Please call']) === 'Please call', 'held tail released at the end');
    ok(run1(['Текст call:x{незакрытый']) === 'Текст ', 'unclosed call dropped');

    const { startTestServer } = require('./helpers/testServer');
    const { connect } = require('./helpers/wsTestClient');
    const { port, close } = await startTestServer();
    const client = await connect(port, '/realtime');
    try {
        await client.waitFor((e) => e.type === 'session.ready');
        client.sendJson({ type: 'session.start', sampleRate: 16000 });
        await client.waitFor((e) => e.type === 'session.config.applied', { timeoutMs: 5000 });
        const texts = [];
        client.sendJson({ type: 'input_text.submit', text: 'Расскажи call:search_wine_knowledge{query:скандал} про вино' });
        await client.waitFor((e) => {
            if (e.type === 'transcript.model') texts.push(e.text);
            return e.type === 'audio.end';
        }, { timeoutMs: 8000, label: 'audio.end' });
        const all = texts.join('');
        ok(all.length > 0 && !/call:|search_wine_knowledge|\{/.test(all) && /Расскажи/.test(all) && /про вино/.test(all), `answer transcript without the call (${all})`);
    } finally {
        client.close();
        await close();
    }
    return { assertionCount: n };
}

module.exports = { run };

if (require.main === module) {
    run().then((r) => { console.log(`toolTextFilter passed (${r.assertionCount})`); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
