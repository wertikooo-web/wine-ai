'use strict';

// Visual Companion part 2: verified partner catalog, URL safety, CTA
// registry, knowledge-tool screen_cards, and the Lite card renderer
// (grounding, stale turns, missing fields). Presentation/control plane only.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'memory';

const t = require('./helpers/assertions');
const catalog = require('../src/companion/companionCatalog');
const { createCompanionApi } = require('../src/companion/companionApi');
const client = require('../public/lite-companion');
const { createImpl } = require('../src/tools/searchLayeredKnowledge');

const REAL = {
    externalId: 'WMD-1001',
    wineryName: 'Castel Mimi',
    wineName: 'Fetească Neagră Reserve',
    vintage: 2019,
    grapes: ['Fetească Neagră'],
    shortDescription: 'Dry red with cherry and spice.',
    imageUrl: 'https://cdn.winemd.md/img/1001.jpg',
    productUrl: 'https://winemd.md/p/1001',
};

function fakeDoc() {
    const created = [];
    function node(tag) {
        const n = {
            tag, className: '', textContent: '', dataset: {}, children: [], parentNode: null, attrs: {},
            appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
            removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
            insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; },
            addEventListener(type, fn) { this.attrs['on' + type] = fn; },
            get nextSibling() { if (!this.parentNode) return null; const s = this.parentNode.children; return s[s.indexOf(this) + 1] || null; },
            get classList() { const self = this; return { contains: (c) => self.className.split(' ').includes(c) }; },
        };
        created.push(n);
        return n;
    }
    return { createElement: node, created };
}
const allText = (n) => [n.textContent, ...n.children.map(allText)].join(' ');

async function run() {
    // ---- validation / URL safety -------------------------------------------
    const ok = catalog.validateRecord(REAL);
    t.ok(ok.record, 'real partner record accepted');
    t.ok(/^cw_[0-9a-f]{16}$/.test(ok.record.wineId), 'stable wine id derived from SKU');
    t.equal(catalog.validateRecord(REAL).record.wineId, ok.record.wineId, 'same SKU -> same id (re-import updates)');
    t.ok(catalog.validateRecord({ wineName: 'X Wine' }).errors.includes('wineryName_required'), 'winery name required');
    for (const [label, url] of [['javascript:', 'javascript:alert(1)'], ['http', 'http://winemd.md/p/1'], ['example.com', 'https://example.com/winemd/demo-wine-001'], ['credentials', 'https://user:pw@winemd.md/p'], ['ip host', 'https://10.0.0.1/p'], ['data:', 'data:text/html,<script>1</script>'], ['garbage', 'not a url']]) {
        t.ok(catalog.validateRecord({ ...REAL, productUrl: url }).errors.includes('productUrl_unsafe'), `${label} product URL rejected`);
    }
    t.ok(catalog.validateRecord({ ...REAL, externalId: 'demo-wine-001' }).errors.includes('demo_record_rejected'), 'demo records rejected');
    process.env.COMPANION_URL_HOSTS = 'winemd.md,*.winemd.md';
    t.ok(catalog.validateRecord(REAL).record, 'allowlisted hosts accepted');
    t.ok(catalog.validateRecord({ ...REAL, productUrl: 'https://winemd.md.evil.com/p' }).errors.includes('productUrl_unsafe'), 'look-alike host rejected by allowlist');
    delete process.env.COMPANION_URL_HOSTS;

    const minimal = catalog.validateRecord({ wineryName: 'Crama Y', wineName: 'Rară Neagră' }).record;
    const minimalCard = catalog.publicCard(minimal);
    t.deepEqual(Object.keys(minimalCard).sort(), ['ctas', 'wineId', 'wineName', 'wineryName'], 'card has only fields that exist (no nulls)');
    t.deepEqual(minimalCard.ctas, [], 'no productUrl -> no purchase CTA');
    const fullCard = catalog.publicCard(ok.record);
    t.deepEqual(fullCard.ctas, [{ type: 'BUY_OR_VIEW_ON_WINEMD', url: 'https://winemd.md/p/1001' }], 'verified productUrl -> WineMD CTA');

    // ---- API ---------------------------------------------------------------
    const store = catalog.createMemoryCompanionStore();
    catalog.setCompanionStoreForTests(store);
    const api = createCompanionApi({ sendJson: (res, s, b) => { res.status = s; res.body = b; }, readJsonBody: async (req) => req.body, getStore: () => store });
    const call = async (method, path, body, headers = {}) => { const res = {}; await api.handle({ method, headers, body }, res, path); return res; };

    let res = await call('GET', '/api/companion/catalog');
    t.deepEqual(res.body.wines, [], 'empty production catalog -> no wines (no demo fallback)');
    process.env.ADMIN_TOKEN = 'secret';
    res = await call('POST', '/api/companion/wines/import', { wines: [REAL] });
    t.equal(res.status, 401, 'import requires the admin token');
    res = await call('POST', '/api/companion/wines/import', { wines: [REAL, { ...REAL, externalId: 'WMD-2', productUrl: 'javascript:alert(1)' }] }, { 'x-admin-token': 'secret' });
    t.equal(res.body.imported.length, 1, 'valid record imported');
    t.equal(res.body.rejected[0].errors[0], 'productUrl_unsafe', 'unsafe record rejected with reason');
    delete process.env.ADMIN_TOKEN;
    res = await call('GET', '/api/companion/catalog');
    t.equal(res.body.wines.length, 1, 'catalog lists the imported wine');
    t.ok(res.body.wines[0].names.includes('feteasca neagra reserve'), 'normalized match names');
    const wineId = res.body.wines[0].wineId;
    res = await call('GET', `/api/companion/wines/${wineId}`);
    t.equal(res.body.card.wineName, 'Fetească Neagră Reserve', 'card served by id');
    await call('POST', `/api/companion/wines/${wineId}/published`, { published: false });
    t.equal((await call('GET', `/api/companion/wines/${wineId}`)).status, 404, 'unpublished wine is not served');
    t.equal((await call('GET', '/api/companion/catalog')).body.wines.length, 0, 'unpublished wine leaves the catalog');
    await call('POST', `/api/companion/wines/${wineId}/published`, { published: true });
    process.env.VISUAL_COMPANION_ENABLED = 'false';
    t.deepEqual((await call('GET', '/api/companion/catalog')).body.wines, [], 'flag off -> no cards');
    delete process.env.VISUAL_COMPANION_ENABLED;

    // ---- knowledge tool: screen_cards only for verified catalog wines on /lite
    await catalog.refreshIndex();
    const tool = createImpl(async () => ({ found: true, evidence: [{ level: 'documents', title: 'Castel Mimi Fetească Neagră Reserve', text: 'dry red' }], used_levels: ['documents'], web_used: false, answerable: true, conflicts: [], answer_policy: {} }));
    const liteOut = await tool({ query: 'Расскажи про Fetească Neagră Reserve' }, { companionScreen: true });
    t.deepEqual(liteOut.screen_cards, [{ wine: 'Fetească Neagră Reserve', winery: 'Castel Mimi' }], 'lite session: model is told which verified wine is on screen');
    const dashOut = await tool({ query: 'Расскажи про Fetească Neagră Reserve' }, {});
    t.equal(dashOut.screen_cards, undefined, 'dashboard session: no screen_cards');
    const generalTool = createImpl(async () => ({ found: true, evidence: [{ level: 'documents', title: 'Терруар', text: 'почва и климат' }], used_levels: ['documents'], web_used: false, answerable: true, conflicts: [], answer_policy: {} }));
    const otherOut = await generalTool({ query: 'Что такое терруар?' }, { companionScreen: true });
    t.equal(otherOut.screen_cards, undefined, 'no catalog wine mentioned: no screen_cards (model must not promise a link)');
    t.ok(/Do not read, spell out or invent any URL/.test(otherOut.answer_policy.final_instruction), 'lite session: model told never to read or invent URLs');
    t.ok(!/Do not read, spell out/.test(dashOut.answer_policy.final_instruction || ''), 'dashboard session instruction unchanged');

    // ---- client renderer ----------------------------------------------------
    t.equal(client.safeHttpsUrl('javascript:alert(1)'), null, 'client rejects javascript: URLs');
    t.equal(client.safeHttpsUrl('https://example.com/x'), null, 'client rejects example.com');
    t.deepEqual(client.findWines('Советую Castel Mimi Fetească Neagră Reserve!', [{ wineId: 'cw_a', names: ['feteasca neagra reserve'] }]), ['cw_a'], 'client matches catalog names in speech');
    t.deepEqual(client.findWines('Fetească Neagră — отличный сорт', [{ wineId: 'cw_a', names: ['feteasca neagra reserve'] }]), [], 'grape name alone does not show a card');

    {
        const doc = fakeDoc();
        const el = client.buildCard(doc, { wineId: 'cw_b', wineryName: 'Crama Y', wineName: 'Rară Neagră', ctas: [{ type: 'BUY_OR_VIEW_ON_WINEMD', url: 'javascript:alert(1)' }, { type: 'MADE_UP', url: 'https://winemd.md/x' }] }, { lang: 'ru' });
        const text = allText(el);
        t.ok(!/null|undefined|N\/A/.test(text), 'missing fields are hidden, never printed as null/N/A');
        t.ok(!doc.created.some((n) => n.tag === 'a'), 'unsafe or unknown CTAs are never rendered');
        t.ok(!doc.created.some((n) => n.tag === 'img'), 'no image record -> no image');
        const full = client.buildCard(doc, fullCard, { lang: 'ro' });
        const link = doc.created.find((n) => n.tag === 'a');
        t.equal(link.href, 'https://winemd.md/p/1001', 'CTA uses the backend URL');
        t.equal(link.textContent, 'Vezi pe WineMD', 'CTA label comes from the registry, localized');
        t.equal(link.rel, 'noopener noreferrer', 'external link opened safely');
        t.ok(allText(full).includes('Fetească Neagră Reserve 2019'), 'name + vintage shown');
    }

    // controller: grounding + stale turns + max 3
    {
        const doc = fakeDoc();
        const chat = doc.createElement('div');
        const cards = { cw_a: { ...fullCard, wineId: 'cw_a' }, cw_b: { wineId: 'cw_b', wineryName: 'W', wineName: 'Second Wine' } };
        let release;
        const gate = new Promise((r) => { release = r; });
        const fetchImpl = async (url) => {
            if (url === '/api/companion/catalog') return { ok: true, json: async () => ({ enabled: true, wines: [{ wineId: 'cw_a', names: ['feteasca neagra reserve'] }, { wineId: 'cw_b', names: ['second wine'] }] }) };
            const id = url.split('/').pop();
            if (id === 'cw_b') await gate; // slow card
            return cards[id] ? { ok: true, json: async () => ({ ok: true, card: cards[id] }) } : { ok: false, json: async () => ({}) };
        };
        const events = [];
        const comp = client.createCompanion({ doc, fetchImpl, telemetry: (s, d) => events.push([s, d]) });
        const b1 = chat.appendChild(doc.createElement('div'));
        await comp.onAssistantText('g1', 'Попробуйте Fetească Neagră Reserve. Вот ссылка https://evil.example/buy', b1);
        t.equal(chat.children.length, 2, 'card rail inserted after the assistant message');
        t.equal(chat.children[1].children.length, 1, 'one card for one verified wine');
        t.ok(!doc.created.some((n) => n.tag === 'a' && String(n.href).includes('evil')), 'model-generated URL never becomes a link');
        await comp.onAssistantText('g1', 'Попробуйте Fetească Neagră Reserve. И ещё раз Fetească Neagră Reserve', b1);
        t.equal(chat.children[1].children.length, 1, 'same wine is not shown twice in a turn');
        const pending = comp.onAssistantText('g1', 'Также Second Wine', b1);
        const b2 = chat.appendChild(doc.createElement('div'));
        await comp.onAssistantText('g2', 'Новый ответ без вин', b2);
        release();
        await pending;
        t.equal(chat.children[1].children.length, 1, 'a card resolved after its turn was superseded is dropped');
        t.ok(events.some(([s, d]) => s === 'companion_wine_card_shown' && d.wineId === 'cw_a'), 'card_shown analytics sent');
        const failing = client.createCompanion({ doc, fetchImpl: async () => { throw new Error('network down'); } });
        await failing.onAssistantText('g9', 'Fetească Neagră Reserve', doc.createElement('div'));
        t.ok(true, 'network failure is swallowed (conversation unaffected)');
    }

    catalog.setCompanionStoreForTests(null);
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('companionCatalog tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
