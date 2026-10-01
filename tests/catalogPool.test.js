'use strict';

// Fix A: verified wine.md wines (companion_wines facts) as recommendation
// candidates behind RECOMMEND_CATALOG_POOL = off | shadow | on.

const t = require('./helpers/assertions');
const wi = require('../src/knowledge/wineIntelligence');
const { validateRecord } = require('../src/companion/companionCatalog');
const { factsFromRecord } = require('../src/companion/companionWineFacts');
const { catalogPoolMode, catalogCandidates, rankWithCatalog } = require('../src/knowledge/catalogCandidates');

const facts = require('../data/demo-links/winemd-wines.json').map((x) => validateRecord(x).record).filter(Boolean).map(factsFromRecord);
const none = async () => [];
const adapters = { searchRelations: none, searchCanonical: none, searchDocuments: none, searchCatalog: none };
const names = (r) => (r.inference && r.inference.wines ? r.inference.wines.map((w) => w.name) : []);
const byName = (n) => facts.find((f) => f.displayName === n);

async function run() {
    t.equal(catalogPoolMode({}), 'shadow', 'default mode: shadow');
    t.equal(catalogPoolMode({ RECOMMEND_CATALOG_POOL: 'on' }), 'on');
    t.equal(catalogPoolMode({ RECOMMEND_CATALOG_POOL: 'nonsense' }), 'shadow');

    const queries = ['Посоветуй красное сухое вино', 'Посоветуй белое сухое до 200 леев', 'Хочу розовое вино', 'Посоветуй сладкое вино', 'Recomandă-mi un vin roșu sec până la 300 lei', 'I want a dry white wine under 250 lei', 'Какое вино взять к рыбе?'];
    for (const q of queries) {
        const recorded = [];
        const off = await wi.runInference(q, { adapters });
        const shadow = await wi.runInference(q, { adapters, catalogPool: { mode: 'shadow', facts: () => facts, record: (d) => recorded.push(d) } });
        t.equal(JSON.stringify(shadow), JSON.stringify(off), `shadow returns the organic result unchanged: ${q}`);
        const on = await wi.runInference(q, { adapters, catalogPool: { mode: 'on', facts: () => facts } });
        if (on.scenario !== 'recommend_wine' || !on.found) continue;
        const prefs = on.inference.preferences;
        for (const w of on.inference.wines.filter((x) => x.source === 'catalog')) {
            const f = facts.find((x) => x.wineId === w.wine_id);
            t.ok(f, `catalog pick has a real wine id: ${w.name}`);
            if (prefs.color) t.equal(f.color, prefs.color, `colour verified: ${w.name}`);
            if (prefs.sweetness && f.sweetness) t.equal(f.sweetness, prefs.sweetness, `sweetness not contradicted: ${w.name}`);
            if (prefs.budget && f.price != null) t.ok(f.price <= prefs.budget, `budget is hard for a known price: ${w.name} ${f.price}`);
        }
        const wineries = on.inference.wines.map((w) => (w.producer || w.name.split(' ')[0]).toLowerCase());
        t.equal(new Set(wineries).size, wineries.length, `one wine per winery: ${q}`);
    }

    // The previously unreachable range is now recommendable.
    const sweet = await wi.runInference('Посоветуй сладкое вино', { adapters, catalogPool: { mode: 'on', facts: () => facts } });
    t.ok(sweet.found && sweet.inference.wines.length >= 1, 'sweet request now finds verified sweet wines (was: nothing)');
    t.ok(sweet.inference.wines.every((w) => facts.find((f) => f.wineId === w.wine_id).sweetness === 'sweet'), 'all verified sweet');
    const red = await wi.runInference('Посоветуй красное сухое вино', { adapters, catalogPool: { mode: 'on', facts: () => facts } });
    t.ok(red.inference.wines.some((w) => w.source === 'catalog'), 'catalog wines join the red dry recommendation');

    // Pool failure → organic.
    const broken = await wi.runInference('Посоветуй красное сухое вино', { adapters, catalogPool: { mode: 'on', facts: () => { throw new Error('db'); } } });
    t.equal(JSON.stringify(names(broken)), JSON.stringify(names(await wi.runInference('Посоветуй красное сухое вино', { adapters }))), 'pool failure: organic stands');

    // Eligibility unit cases.
    const score = wi.scoreWineCandidate;
    const pool = catalogCandidates({ color: 'white', sweetness: 'dry', budget: 150 }, score, { facts });
    t.ok(pool.length > 0 && pool.every((c) => (byName(c.name) || facts.find((f) => f.wineId === c.wine_id)).color === 'white'), 'only white');
    t.ok(pool.every((c) => c.price == null || c.price <= 150), 'none over 150');
    t.equal(catalogCandidates({ food: 'fish' }, score, { facts }).length, 0, 'food-only request: catalog has no verified food data');
    t.equal(catalogCandidates({}, score, { facts }).length, 0, 'no constraint: no catalog candidates');
    // Unknown sweetness is allowed but ranked below a verified match.
    const synthetic = [
        { wineId: 'cw_a', displayName: 'A Wine', wineryName: 'A', color: 'red', sweetness: null, price: 200 },
        { wineId: 'cw_b', displayName: 'B Wine', wineryName: 'B', color: 'red', sweetness: 'dry', price: 200 },
        { wineId: 'cw_c', displayName: 'C Wine', wineryName: 'C', color: 'red', sweetness: 'sweet', price: 100 },
    ];
    const ranked = rankWithCatalog([], catalogCandidates({ color: 'red', sweetness: 'dry' }, score, { facts: synthetic }), { color: 'red', sweetness: 'dry' });
    t.equal(ranked.map((c) => c.wine_id).join(','), 'cw_b,cw_a', 'verified dry first, unknown after, sweet excluded');

    // Grounding fix: a blend never grounds to a single-varietal profile.
    const blend = await wi.runInference('Посоветуй красное сухое вино', { adapters: { ...adapters, searchCatalog: async () => [{ level: 'catalog', title: 'Aurelius Cabernet Sauvignon & Merlot & Feteasca Neagra', text: 'x', catalog: { price: 159, product_url: 'https://wine.md/ru/catalog/wine/vinuri-rosii/aurelius-blend' } }] } });
    t.ok(!names(blend).includes('Aurelius Cabernet Sauvignon & Merlot & Feteasca Neagra'), 'blend not mis-grounded as Cabernet Sauvignon 2018');

    // Pairing: official and catalog bottles only when the pool is on.
    const pairOff = await wi.runInference('Какое вино взять к рыбе?', { adapters });
    t.ok(pairOff.inference.candidates.every((c) => !c.bottles.length), 'pool off: pairing output as before');
    const pairOn = await wi.runInference('Какое вино взять к рыбе?', { adapters, catalogPool: { mode: 'on', facts: () => facts } });
    t.ok(pairOn.inference.candidates.some((c) => c.bottles.length), 'pool on: real bottles for the pairing styles');

    // Hot path: candidate selection over the full catalogue.
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 200; i += 1) rankWithCatalog([], catalogCandidates({ color: 'red', sweetness: 'dry', budget: 300 }, score, { facts }), { color: 'red', sweetness: 'dry', budget: 300 });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
    console.log(`  catalog pool over ${facts.length} wines: ${ms.toFixed(3)} ms per recommendation`);
    t.ok(ms < 10, 'catalog pool under 10 ms');
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('catalogPool tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
