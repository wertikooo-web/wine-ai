'use strict';

// Verified winery links + link analytics for the Visual Companion.
// - Links come only from data/demo-links/wineries.json (Ghid + wine.md),
//   never from the model; unsafe URLs are dropped.
// - Winery names are found in Russian speech (inflected) and Latin.
// - The client renders only https CTAs with known types.
// - link events: fixed vocabulary, summary with CTR and missing links.

const t = require('./helpers/assertions');
const wineryLinks = require('../src/companion/wineryLinks');
const linkEvents = require('../src/analytics/linkEvents');
const companion = require('../public/lite-companion.js');
const { createImpl } = require('../src/tools/searchLayeredKnowledge');
const { classifyRoute } = require('../src/security/adminAuth');

async function run() {
    // --- data -> wineries with verified CTAs only
    const list = wineryLinks.loadWineries();
    t.ok(list.length >= 40, `wineries loaded (${list.length})`);
    const purcari = list.find((w) => w.name === 'Chateau Purcari');
    t.ok(purcari, 'Purcari present');
    t.deepEqual(purcari.ctas.map((c) => c.type), ['BOOK_TOUR', 'WINERY_ON_WINEMD', 'VISIT_WINERY_SITE'], 'Purcari: tour, wine.md, official site');
    t.equal(purcari.ctas[0].url, 'https://wine.md/ru/tourism/vinaria-purcari', 'tour link exactly as wine.md publishes it');
    t.ok(list.every((w) => w.ctas.every((c) => c.url.startsWith('https://'))), 'every CTA is https');
    const built = wineryLinks.buildWineries([{ winery: 'Bad', official_site: 'http://evil.example.com', wine_md_brand: 'javascript:alert(1)' }, { winery: 'Ok', official_site: 'https://ok.md' }]);
    t.equal(built.length, 1, 'a winery with only unsafe links is dropped');
    t.deepEqual(built[0].ctas.map((c) => c.type), ['VISIT_WINERY_SITE']);

    // --- name matching: Russian inflection, Latin, no false positives
    const names = (text) => wineryLinks.findWineriesInTexts([text]).map((w) => w.name);
    t.deepEqual(names('Расскажи про винодельню Пуркарь'), ['Chateau Purcari']);
    t.deepEqual(names('подвалы Криковы'), ['Cricova'], 'inflected Russian name');
    t.deepEqual(names('о Пуркаре и не только'), ['Chateau Purcari'], 'inflected Russian name (prepositional)');
    t.deepEqual(names('Castel Mimi wine resort'), ['Castel Mimi']);
    t.deepEqual(names('крикет и пуркуа па'), [], 'no false positives on similar words');
    t.deepEqual(names('Aroma of cherry'), [], 'generic Latin words are not winery names');

    // --- knowledge tool: screen_wineries + honest instruction + events
    linkEvents.setLinkEventStoreForTests(linkEvents.createMemoryLinkEventStore());
    const routed = async () => ({ found: true, evidence: [{ title: 'Purcari', text: 'Chateau Purcari, Stefan Voda.' }], used_levels: ['documents'], answerable: true, conflicts: [], answer_policy: { final_instruction: 'Answer.' } });
    const tool = createImpl(routed);
    const out = await tool({ query: 'Как забронировать экскурсию в Пуркарь?' }, { isWebSearchEnabled: () => true, companionScreen: true });
    t.deepEqual(out.screen_wineries, ['Chateau Purcari'], 'winery named in the question is put on screen');
    t.ok(/screen_wineries/.test(out.answer_policy.final_instruction) && /Never say or invent a URL/.test(out.answer_policy.final_instruction), 'model told the links are on screen, never to say a URL');
    const noScreen = await tool({ query: 'Как забронировать экскурсию в Пуркарь?' }, { isWebSearchEnabled: () => true, companionScreen: false });
    t.equal(noScreen.screen_wineries, undefined, 'no screen (dashboard / kiosk): nothing attached');
    await tool({ query: 'дай ссылку на сайт винодельни Неизвестная' }, { isWebSearchEnabled: () => true, companionScreen: true });
    await new Promise((r) => setTimeout(r, 10));
    const rows = await linkEvents.getLinkEventStore().list();
    t.ok(rows.some((r) => r.event === 'link_resolved' && r.entity_id === 'wy_chateau-purcari'), 'link_resolved recorded');
    t.ok(rows.some((r) => r.event === 'link_missing' && /Неизвестная/.test(r.detail)), 'link_missing recorded for a link request without a verified link');

    // --- events: validation + summary
    t.equal(linkEvents.validateEvent({ event: 'drop_table' }), null, 'unknown event rejected');
    t.equal(linkEvents.validateEvent({ event: 'link_clicked' }), null, 'click without entity rejected');
    const summary = linkEvents.summarize([
        { event: 'link_rendered', entity_type: 'winery', entity_id: 'wy_x', entity_name: 'X', cta_type: 'BOOK_TOUR', session_id: 's1' },
        { event: 'link_rendered', entity_type: 'winery', entity_id: 'wy_x', entity_name: 'X', cta_type: 'VISIT_WINERY_SITE', session_id: 's1' },
        { event: 'link_clicked', entity_type: 'winery', entity_id: 'wy_x', entity_name: 'X', cta_type: 'BOOK_TOUR', session_id: 's1' },
        { event: 'link_missing', entity_type: 'unknown', entity_id: null, detail: 'сайт Y', cta_type: 'none' },
    ]);
    t.equal(summary.entities[0].rendered, 2);
    t.equal(summary.entities[0].clicked, 1);
    t.equal(summary.entities[0].ctrPct, 50, 'CTR per entity');
    t.equal(summary.byCta.BOOK_TOUR.ctrPct, 100, 'CTR per button type');
    t.equal(summary.missing[0].name, 'сайт Y', 'missing links listed');
    t.equal(summary.sessions, 1);

    // --- client: winery card renders only verified https CTAs; clicks reported
    t.deepEqual(companion.findWineries('Советую Криковы подвалы', list).map((w) => w.name), ['Cricova'], 'client finds inflected Russian names too');
    const doc = fakeDoc();
    const clicks = [];
    const card = companion.buildWineryCard(doc, { wineryId: 'wy_x', name: 'X', ctas: [{ type: 'BOOK_TOUR', url: 'https://wine.md/ru/tourism/x', info: '3 экскурсии, от 200 MDL' }, { type: 'VISIT_WINERY_SITE', url: 'http://insecure.md' }, { type: 'EVIL', url: 'https://evil.md' }] }, { lang: 'ru', onCtaClick: (w, c) => clicks.push(c.type) });
    const links = card.findAll('a');
    t.equal(links.length, 1, 'only the https CTA of a known type is rendered');
    t.equal(links[0].href, 'https://wine.md/ru/tourism/x');
    t.equal(links[0].textContent, 'Забронировать экскурсию');
    t.equal(links[0].rel, 'noopener noreferrer');
    links[0].click();
    t.deepEqual(clicks, ['BOOK_TOUR'], 'click reported');
    t.equal(companion.buildWineryCard(doc, { wineryId: 'wy_y', name: 'Y', ctas: [] }), null, 'no CTA -> no card');

    // --- routes: participant endpoints public, analytics admin
    t.equal(classifyRoute('GET', '/api/companion/wineries'), 'public');
    t.equal(classifyRoute('POST', '/api/analytics/link-event'), 'public');
    t.equal(classifyRoute('GET', '/api/analytics/links'), 'admin', 'link analytics is admin-only');
    t.equal(classifyRoute('GET', '/dashboard/links'), 'admin', 'stats page is admin-only');
}

// Minimal DOM for buildWineryCard.
function fakeDoc() {
    function node(tag) {
        const n = {
            tagName: tag.toUpperCase(), className: '', textContent: '', children: [], dataset: {}, listeners: {},
            appendChild(c) { this.children.push(c); return c; },
            addEventListener(type, fn) { this.listeners[type] = fn; },
            click() { if (this.listeners.click) this.listeners.click(); },
            findAll(t2) { const out = []; const walk = (x) => { for (const c of x.children) { if (c.tagName === t2.toUpperCase()) out.push(c); walk(c); } }; walk(this); return out; },
        };
        return n;
    }
    return { createElement: node };
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('wineryLinks tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
