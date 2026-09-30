'use strict';

// show_links: the guest asks for a site / map / Instagram / Facebook link and
// gets VERIFIED clickable links in the chat text (+ the wine photo). The
// model never writes a URL; missing kinds are reported honestly.

const t = require('./helpers/assertions');
const showLinks = require('../src/tools/showLinks');
const catalog = require('../src/companion/companionCatalog');
const companion = require('../public/lite-companion.js');
const { TOOL_DECLARATIONS } = require('../src/tools');
const { CORE_PERSONA_PROMPT } = require('../src/persona/wineExpertPersona');
const linkEvents = require('../src/analytics/linkEvents');

async function run() {
    linkEvents.setLinkEventStoreForTests(linkEvents.createMemoryLinkEventStore());
    t.ok(TOOL_DECLARATIONS.some((d) => d.name === 'show_links'), 'show_links is offered to the model');
    t.ok(/show_links/.test(CORE_PERSONA_PROMPT) && /Instagram/.test(CORE_PERSONA_PROMPT), 'persona: asked for a link -> call show_links');

    const events = [];
    const ctx = { companionScreen: true, emitToClient: (e) => events.push(e), _currentGenerationId: 'gen_1' };

    // Winery: site, map, Instagram, Facebook, tours, WineMD.
    const out = await showLinks.impl({ name: 'Пуркарь' }, ctx);
    t.equal(out.found, true);
    t.deepEqual(out.shown_in_chat, ['site', 'map', 'instagram', 'facebook', 'tours', 'winemd']);
    t.ok(/Never read, spell or invent a URL/.test(out.instruction), 'model told not to say URLs');
    const ev = events[0];
    t.equal(ev.type, 'companion.links');
    t.equal(ev.generation_id, 'gen_1', 'links attach to the answer of the same generation');
    t.equal(ev.links.find((l) => l.kind === 'instagram').url, 'https://www.instagram.com/purcari_wines', 'Instagram from the winery site itself');
    t.ok(ev.links.find((l) => l.kind === 'map').url.startsWith('https://www.google.com/maps/search/?api=1&query='), 'map = Google Maps search for the name');
    t.ok(ev.links.every((l) => l.url.startsWith('https://')), 'all https');

    // Only the kinds asked for; missing kinds reported.
    events.length = 0;
    const onlyMap = await showLinks.impl({ name: 'Castel Mimi', kinds: ['map', 'instagram'] }, ctx);
    t.deepEqual(onlyMap.shown_in_chat, ['map', 'instagram']);
    const noSocial = await showLinks.impl({ name: 'Crama Mircești', kinds: ['instagram'] }, ctx);
    t.ok(noSocial.missing.includes('instagram') || noSocial.shown_in_chat.includes('instagram'), 'a missing kind is reported, never invented');

    // Wine from the catalog: wine page + photo + winery links.
    const store = catalog.createMemoryCompanionStore();
    catalog.setCompanionStoreForTests(store);
    const { record } = catalog.validateRecord({ wineryName: 'Chateau Purcari', wineName: 'Negru de Purcari', productUrl: 'https://wine.md/ru/catalog/wine/vinuri-rosii/purcari-negru-de-purcari', imageUrl: 'https://wine.md/assets/images/products/708/negru.png', price: 452, currency: 'MDL' });
    await store.upsert(record);
    await catalog.refreshIndex();
    events.length = 0;
    const wine = await showLinks.impl({ name: 'Negru de Purcari' }, ctx);
    t.equal(wine.found, true);
    t.equal(wine.shown_in_chat[0], 'wine_page', 'wine page first');
    t.equal(events[0].image_url, 'https://wine.md/assets/images/products/708/negru.png', 'wine photo sent');
    t.equal(events[0].price, '452 MDL');
    t.ok(wine.shown_in_chat.includes('instagram'), 'the wine\'s winery links too');

    // Unknown name / no screen: honest, nothing emitted.
    events.length = 0;
    const unknown = await showLinks.impl({ name: 'Несуществующая винодельня' }, ctx);
    t.equal(unknown.found, false);
    t.equal(events.length, 0);
    const noScreen = await showLinks.impl({ name: 'Purcari' }, { companionScreen: false });
    t.equal(noScreen.found, false, 'kiosk / dashboard: no chat screen, no links promised');

    // Client: clickable text links with hostnames; unsafe dropped.
    const doc = fakeDoc();
    const clicks = [];
    const block = companion.buildLinksBlock(doc, { title: 'Negru de Purcari', price: '452 MDL', image_url: 'https://wine.md/x.png', links: [{ kind: 'site', url: 'https://purcariwineries.com/' }, { kind: 'instagram', url: 'https://www.instagram.com/purcari_wines' }, { kind: 'facebook', url: 'http://facebook.com/x' }, { kind: 'evil', url: 'https://evil.md' }] }, { lang: 'ru', onLinkClick: (p, l) => clicks.push(l.kind) });
    const anchors = block.findAll('a');
    t.deepEqual(anchors.map((a) => a.href), ['https://purcariwineries.com/', 'https://www.instagram.com/purcari_wines'], 'only https links of known kinds');
    t.equal(anchors[0].textContent, '🌐 Сайт винодельни');
    t.equal(anchors[0].rel, 'noopener noreferrer');
    t.ok(block.findAll('img').length === 1, 'wine photo shown');
    anchors[1].click();
    t.deepEqual(clicks, ['instagram']);
    t.equal(companion.buildLinksBlock(doc, { links: [] }), null);
}

function fakeDoc() {
    function node(tag) {
        return {
            tagName: tag.toUpperCase(), className: '', textContent: '', children: [], dataset: {}, listeners: {},
            appendChild(c) { this.children.push(c); return c; },
            addEventListener(type, fn) { this.listeners[type] = fn; },
            click() { if (this.listeners.click) this.listeners.click(); },
            findAll(t2) { const out = []; const walk = (x) => { for (const c of x.children) { if (c.tagName === t2.toUpperCase()) out.push(c); walk(c); } }; walk(this); return out; },
        };
    }
    return { createElement: node };
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('showLinks tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
