'use strict';

// Enriches data/demo-links/winemd-wines.json (the companion_wines import
// source) with wine.md's own product characteristics, normalized
// deterministically by src/companion/wineAttributes.js. Nothing is guessed:
// a field is added only when wine.md states it (characteristics block,
// catalog category, or its own description's explicit classification).
//
// Input: the CHAR lines printed by scripts/diag/winemd-wines-crawl.js
//   CHAR\t<path after /catalog/wine/>\t<year>\t<colour>\t<taste>\t<grapes>\t<alcohol>\t<serving>\t<compat,...>
//
//   node scripts/enrich-companion-wines.js crawl.log [--write]

const fs = require('fs');
const path = require('path');
const { normalizeWineAttributes } = require('../src/companion/wineAttributes');

const DATA = path.join(__dirname, '..', 'data', 'demo-links', 'winemd-wines.json');
const SWEETNESS_RU = Object.freeze({ dry: 'Сухое', semi_dry: 'Полусухое', semi_sweet: 'Полусладкое', sweet: 'Сладкое' });

function parseCharLines(text) {
    const byPath = new Map();
    for (const line of String(text).split(/\r?\n/)) {
        const i = line.indexOf('CHAR\t');
        if (i < 0) continue;
        const [, urlPath, year, color, taste, grapes, alcohol, serving, compat] = line.slice(i).split('\t');
        if (!urlPath) continue;
        byPath.set(urlPath.trim(), { year, color, taste, grapes, alcohol, serving, compatibility: String(compat || '').split(',').map((s) => s.trim()).filter(Boolean) });
    }
    return byPath;
}

function enrich(wines, byPath) {
    const stats = { total: wines.length, matched: 0, sweetness: { characteristics: 0, category: 0, description: 0, unknown: 0 }, color: 0, grapes: 0, vintage: 0, alcohol: 0, serving: 0 };
    const out = wines.map((w) => {
        const urlPath = String(w.productUrl || '').replace('https://wine.md/ru/catalog/wine/', '');
        const characteristics = byPath.get(urlPath) || null;
        if (characteristics) stats.matched += 1;
        const a = normalizeWineAttributes({ productUrl: w.productUrl, description: w.shortDescription, characteristics });
        const next = { ...w };
        if (a.sweetness) {
            next.sweetness = a.sweetnessLabel || SWEETNESS_RU[a.sweetness];
            next.sweetnessSource = a.sweetnessSource;
            stats.sweetness[a.sweetnessSource] += 1;
        } else stats.sweetness.unknown += 1;
        // `type` is the card's colour label; dessert / collection category
        // labels ("сладкое", "коллекционное") get wine.md's own colour.
        if (a.color) {
            stats.color += 1;
            if (a.colorSource === 'characteristics' && !/красн|бел|розов|игрист/i.test(String(w.type || ''))) {
                next.type = String(characteristics.color).trim().toLowerCase();
                stats.typeFromColor = (stats.typeFromColor || 0) + 1;
            }
        }
        if (a.grapes.length) { next.grapes = a.grapes; stats.grapes += 1; }
        if (a.vintage) { next.vintage = a.vintage; stats.vintage += 1; }
        if (a.alcohol) { next.alcohol = a.alcohol; stats.alcohol += 1; }
        if (a.servingTemperature) { next.servingTemperature = a.servingTemperature; stats.serving += 1; }
        // wine.md's "Совместимость" icons are not per-wine data (crawl 1 Oct:
        // "cheese" on 387/471 products, "roast" on the rest), so no food
        // pairing is taken from them.
        return next;
    });
    return { wines: out, stats };
}

if (require.main === module) {
    const [logFile, flag] = process.argv.slice(2);
    if (!logFile) { console.error('usage: node scripts/enrich-companion-wines.js crawl.log [--write]'); process.exit(1); }
    const wines = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    const { wines: next, stats } = enrich(wines, parseCharLines(fs.readFileSync(logFile, 'utf8')));
    console.log(JSON.stringify(stats, null, 1));
    if (flag === '--write') { fs.writeFileSync(DATA, `${JSON.stringify(next, null, 1)}\n`); console.log(`written ${DATA}`); }
}

module.exports = { parseCharLines, enrich, SWEETNESS_RU };
