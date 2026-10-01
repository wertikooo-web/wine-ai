'use strict';

// Deterministic wine attribute normalization (wine.md characteristics block,
// category, explicit description classification). Nothing is inferred.

const path = require('path');
const t = require('./helpers/assertions');
const a = require('../src/companion/wineAttributes');
const { parseCharLines, enrich } = require('../scripts/enrich-companion-wines');
const { colorOf, sweetnessOf } = require('../src/companion/companionWineFacts');

async function run() {
    const labels = { 'Сухое': 'dry', 'Брют': 'dry', 'Полусухое': 'semi_dry', 'Полусладкое': 'semi_sweet', 'Сладкое': 'sweet', 'Десертное': 'sweet', 'Sec': 'dry', 'Demisec': 'semi_dry', 'Demidulce': 'semi_sweet', 'Dulce': 'sweet', 'Semi-dry': 'semi_dry', 'Semi-sweet': 'semi_sweet', 'Dry': 'dry', 'Sweet': 'sweet' };
    for (const [label, want] of Object.entries(labels)) t.equal(a.sweetnessFromLabel(label), want, `sweetness label ${label}`);
    t.equal(a.sweetnessFromLabel('Вино с нотами сухофруктов и долгим послевкусием'), null, 'prose is not a label');
    for (const [label, want] of Object.entries({ 'Красное': 'red', 'Белое': 'white', 'Розовое': 'rose', 'Игристое': 'sparkling', 'roșu': 'red', 'alb': 'white', 'Rosé': 'rose' })) t.equal(a.colorFromLabel(label), want, `colour ${label}`);

    t.equal(a.sweetnessFromDescription('Красное сухое вино из Каберне'), 'dry');
    t.equal(a.sweetnessFromDescription('Букет сухофруктов и сухих трав'), null, 'сухофрукты is not a classification');
    t.equal(a.sweetnessFromDescription('Лёгкое полусухое белое вино'), 'semi_dry');
    t.equal(a.sweetnessFromDescription('Красное сухое вино. Белое сладкое вино.'), null, 'conflicting statements stay unknown');

    const n = a.normalizeWineAttributes({ productUrl: 'https://wine.md/ru/catalog/wine/vinuri-albe/traminer/purcari-parcela-traminer', characteristics: { year: '2025', color: 'Белое', taste: 'Сухое', grapes: 'Traminer', alcohol: '13.5%', serving: '10-12°С' } });
    t.equal(n.color, 'white'); t.equal(n.colorSource, 'characteristics'); t.equal(n.sweetness, 'dry'); t.equal(n.sweetnessSource, 'characteristics');
    t.equal(n.vintage, 2025); t.equal(n.alcohol, 13.5); t.equal(n.grapes[0], 'Traminer');
    t.equal(a.normalizeWineAttributes({ productUrl: 'https://wine.md/ru/catalog/wine/vinuri-dulci/x' }).sweetness, 'sweet', 'category vinuri-dulci');
    const none = a.normalizeWineAttributes({ productUrl: 'https://wine.md/ru/catalog/wine/vinuri-rosii/x', description: 'Насыщенное вино' });
    t.equal(none.sweetness, null, 'nothing stated: unknown'); t.equal(none.color, 'red', 'colour from category');
    t.equal(JSON.stringify(a.parseGrapes('Cabernet Sauvignon, Merlot & Fetească Neagră')), JSON.stringify(['Cabernet Sauvignon', 'Merlot', 'Fetească Neagră']));

    // Enrichment from crawl lines (CHAR format), never inventing missing data.
    const byPath = parseCharLines('x CHAR\tvinuri-rosii/a\t2021\tКрасное\tПолусухое\tMerlot\t13%\t16-18°С\tcheese\nCHAR\tvinuri-dulci/b\t\tБелое\t\t\t\t\t');
    const { wines, stats } = enrich([
        { productUrl: 'https://wine.md/ru/catalog/wine/vinuri-rosii/a', type: 'красное', wineName: 'A', wineryName: 'W' },
        { productUrl: 'https://wine.md/ru/catalog/wine/vinuri-dulci/b', type: 'сладкое', wineName: 'B', wineryName: 'W' },
        { productUrl: 'https://wine.md/ru/catalog/wine/vinuri-albe/c', type: 'белое', wineName: 'C', wineryName: 'W', shortDescription: 'Ароматное вино' },
    ], byPath);
    t.equal(wines[0].sweetness, 'Полусухое'); t.equal(wines[0].sweetnessSource, 'characteristics'); t.equal(wines[0].vintage, 2021);
    t.ok(!wines[0].foodPairings, 'template compatibility icons are not food pairings');
    t.equal(wines[1].type, 'белое', 'dessert category label gets wine.md colour'); t.equal(wines[1].sweetness, 'Сладкое'); t.equal(wines[1].sweetnessSource, 'category');
    t.ok(!wines[2].sweetness && !wines[2].vintage && !wines[2].grapes, 'unmatched wine: nothing added');
    t.equal(stats.sweetness.unknown, 1);

    // Runtime adapter (#111 promotions) reads the same labels.
    t.equal(sweetnessOf({ sweetness: 'Брют' }), 'dry'); t.equal(sweetnessOf({ sweetness: 'Полусладкое' }), 'semi_sweet'); t.equal(sweetnessOf({ type: 'сладкое' }), 'sweet');
    t.equal(colorOf({ type: 'розовое' }), 'rose');

    // The committed import data: coverage from wine.md's own markup.
    const data = require(path.join('..', 'data', 'demo-links', 'winemd-wines.json'));
    const withSweet = data.filter((w) => w.sweetness).length;
    t.ok(withSweet >= 400, `import data: sweetness on ${withSweet}/${data.length}`);
    t.ok(data.every((w) => !w.sweetness || ['characteristics', 'category', 'description'].includes(w.sweetnessSource)), 'every sweetness has a source');
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('wineAttributes tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
