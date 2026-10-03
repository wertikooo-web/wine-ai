'use strict';

// check_wine_md_availability on the Lite screen (production 2026-10-03: the
// model said it was "showing the card" while nothing appeared). Found
// products are put into the chat as clickable wine.md links; the model gets
// titles only, never URLs; off-site URLs are dropped. Network is stubbed.
const t = require('./helpers/assertions');
const { impl } = require('../src/tools/checkWineMdAvailability');

function stubFetch(results) {
    const original = global.fetch;
    global.fetch = async (url) => {
        if (String(url) === 'https://wine.md/') {
            return { ok: true, headers: { getSetCookie: () => ['PHPSESSID=abc; path=/'] } };
        }
        return { ok: true, json: async () => ({ success: true, data: { results } }) };
    };
    return () => { global.fetch = original; };
}

async function run() {
    let n = 0;
    const ok = (c, m) => { t.ok(c, m); n += 1; };
    const emitted = [];
    const screen = { companionScreen: true, emitToClient: (e) => emitted.push(e), _currentGenerationId: 'gen_1' };

    let restore = stubFetch([
        { value: '<b>Negru</b> de Purcari 2019', url: 'negru-de-purcari-2019.html' },
        { value: 'Evil', url: 'https://evil.example/x' },
        { value: 'Rosu de Purcari', url: 'https://wine.md/rosu-de-purcari.html' },
    ]);
    try {
        const out = await impl({ query: 'Negru de Purcari' }, screen);
        ok(out.found === true, 'found');
        ok(emitted.length === 2 && emitted.every((e) => e.type === 'companion.links' && e.generation_id === 'gen_1'), 'two wine.md links put in the chat (off-site one dropped)');
        ok(emitted[0].title === 'Negru de Purcari 2019' && emitted[0].links[0].kind === 'wine_page' && emitted[0].links[0].url === 'https://wine.md/negru-de-purcari-2019.html', 'relative URL resolved on wine.md, markup stripped');
        ok(!JSON.stringify(out).includes('http'), 'the model never receives a URL');
        ok(/now shown in the chat/.test(out.note) && /Never say you are showing a card/.test(out.note), 'model told: links are in the chat, never a card');
    } finally { restore(); }

    emitted.length = 0;
    restore = stubFetch([{ value: 'Negru de Purcari', url: 'negru.html' }]);
    try {
        const out = await impl({ query: 'Negru de Purcari' }, {});
        ok(emitted.length === 0 && /no chat screen/.test(out.note), 'no screen (voice-only) -> nothing emitted, honest note');
    } finally { restore(); }

    restore = stubFetch([]);
    try {
        const out = await impl({ query: 'Unknown wine' }, screen);
        ok(out.found === false && emitted.length === 0 && /show_links/.test(out.note) && /Never say you are showing a card/.test(out.note), 'not found -> offer the winery links, never claim a card');
    } finally { restore(); }
    return { assertionCount: n };
}

module.exports = { run };

if (require.main === module) {
    run().then((r) => { console.log(`checkWineMdAvailability passed (${r.assertionCount})`); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
