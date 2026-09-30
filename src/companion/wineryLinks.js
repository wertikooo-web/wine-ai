'use strict';

// Verified winery links for the Visual Companion (Wine AI Lite).
//
// Source: data/demo-links/wineries.json -- official websites printed in
// Ghidul vinului (checked alive) and the brand / excursion-booking pages
// wine.md itself publishes. Built by scripts/diag/demo-links-verify.js and
// reviewed by the operator; nothing here is generated.
//
// The model never supplies a URL. The client (public/lite-companion.js)
// shows a winery card when the assistant names a winery from this list, and
// only with the CTAs returned here (re-validated as https).
// WINERY_LINKS_ENABLED=false turns the whole feature off.

const fs = require('fs');
const path = require('path');
const { safeHttpsUrl } = require('./companionCatalog');

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'demo-links', 'wineries.json');

const WINERY_CTA_TYPES = Object.freeze({
    BOOK_TOUR: 'BOOK_TOUR',
    WINERY_ON_WINEMD: 'WINERY_ON_WINEMD',
    VISIT_WINERY_SITE: 'VISIT_WINERY_SITE',
});

// Names the assistant actually says in Russian (from wine.md's own Russian
// tour titles) and common spellings. Matched as whole words after
// normalization, in addition to the Latin name itself.
const ALIASES = Object.freeze({
    'Chateau Purcari': ['Purcari', 'Пуркарь', 'Пуркари', 'Château Purcari', 'Шато Пуркарь'],
    Cricova: ['Крикова', 'Криково'],
    'Mileștii Mici': ['Milestii Mici', 'Милештий Мичь', 'Милештий Мич', 'Милешти Мич'],
    'Castel Mimi': ['Кастель Мими', 'Замок Мими', 'Castel Mimi'],
    'Château Vartely': ['Chateau Vartely', 'Vartely', 'Вартели', 'Шато Вартели'],
    'Et Cetera': ['Etcetera', 'Эт Сетера', 'Эт Цетера'],
    'Barza Albă': ['Barza Alba', 'Белый Аист', 'Барза Албэ'],
    'Buket Moldavii': ['Букет Молдавии', 'Букет Молдовы', 'Bouquet of Moldova'],
    'Vinăria Poiana': ['Poiana', 'Пояна'],
    'Vinuri de Comrat': ['Вина Комрата', 'Вина де Комрат'],
    'Basavin Winery': ['Basavin', 'Басавин'],
    KVINT: ['Kvint', 'Квинт'],
    'Kara Gani': ['Karagani', 'Кара Гани'],
    'Chateau Cojușna': ['Cojusna', 'Cojușna', 'Кожушна', 'Шато Кожушна'],
    'Crama Mircești': ['Mircesti', 'Mircești', 'Мирчешть', 'Мирчешты'],
    'Asconi Winery': ['Asconi', 'Асконь', 'Аскони'],
    'Carlevana Winery': ['Carlevana', 'Карлевана'],
    'Aurelius Winery': ['Aurelius', 'Аурелиус'],
    'Fautor Winery': ['Fautor', 'Фаутор'],
    'Rădăcini': ['Radacini', 'Рэдэчинь', 'Радачини'],
    'Dumitraș Winery': ['Dumitras', 'Dumitraș', 'Думитраш'],
    'Gitana Winery': ['Gitana', 'Гитана'],
    'Domeniile Cuza': ['Cuza', 'Домений Куза'],
    'Timbrus Purcari Estate': ['Timbrus', 'Тимбрус'],
    'Bostavan': ['Боставан'],
    'Kislov Winery': ['Kislov', 'Кислов'],
    'Vinum Estate': ['Vinum'],
    'Vornic Winery': ['Vornic', 'Ворник'],
    'Château Cristi': ['Chateau Cristi'],
    'Pelican Negru': ['Пеликан Негру'],
    'Sălcuța': ['Salcuta', 'Сэлкуца', 'Салкуца'],
    'Tomai': ['Томай'],
});

// Latin words too generic to identify a winery on their own.
const WEAK_NAMES = new Set(['aroma', 'equinox', 'impresario', 'vindicum', 'maurt', 'bardar', 'tomai', 'vinum']);

function normalizeName(text) {
    return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[şș]/g, 's').replace(/[ţț]/g, 't').replace(/ё/g, 'е')
        .replace(/[^a-z0-9а-я]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

function wineryId(name) {
    return `wy_${normalizeName(name).replace(/ /g, '-').slice(0, 60)}`;
}

function matchNames(row) {
    const names = new Set();
    const add = (n) => { const v = normalizeName(n); if (v && v.length >= 4 && !WEAK_NAMES.has(v)) names.add(v); };
    add(row.winery);
    // "Chateau Purcari" should also match plain "Purcari" in speech.
    add(String(row.winery).replace(/\b(Winery|Chateau|Château|Crama|Vinăria|Vinaria|Estate|Domeniile)\b/gi, ''));
    for (const alias of ALIASES[row.winery] || []) add(alias);
    return [...names];
}

function buildWineries(rows) {
    const out = [];
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || !row.winery) continue;
        const ctas = [];
        const tour = safeHttpsUrl(row.wine_md_tours);
        if (tour) ctas.push({ type: WINERY_CTA_TYPES.BOOK_TOUR, url: tour, info: row.tours_info || null });
        const brand = safeHttpsUrl(typeof row.wine_md_brand === 'string' ? row.wine_md_brand : null);
        if (brand) ctas.push({ type: WINERY_CTA_TYPES.WINERY_ON_WINEMD, url: brand });
        const site = safeHttpsUrl(row.official_site);
        if (site) ctas.push({ type: WINERY_CTA_TYPES.VISIT_WINERY_SITE, url: site });
        if (!ctas.length) continue;
        const entry = { wineryId: wineryId(row.winery), name: row.winery, names: matchNames(row), ctas };
        // Social pages linked from the winery's own website (show_links).
        const instagram = safeHttpsUrl(row.instagram);
        const facebook = safeHttpsUrl(row.facebook);
        if (instagram) entry.instagram = instagram;
        if (facebook) entry.facebook = facebook;
        out.push(entry);
    }
    return out;
}

let cache = null;
function loadWineries({ file = DATA_FILE } = {}) {
    if (cache && cache.file === file) return cache.list;
    let rows = [];
    try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { console.warn('[WineryLinks] data_unavailable', String(error && error.message).slice(0, 120)); }
    cache = { file, list: buildWineries(rows) };
    return cache.list;
}

function isEnabled(env = process.env) {
    return String(env.WINERY_LINKS_ENABLED || 'true').toLowerCase() !== 'false';
}

// Russian names are inflected ("в Криковы", "о Пуркаре"): a Cyrillic name
// also matches its stem (last vowel / soft sign dropped) plus up to three
// letters of ending. Latin names match as whole words only.
const matcherCache = new Map();
function nameMatcher(name) {
    if (!matcherCache.has(name)) {
        const words = name.split(' ');
        const last = words[words.length - 1];
        let pattern = null;
        if (/^[а-я]+$/.test(last) && last.length >= 5) {
            const stem = last.replace(/[аяоеиыуюьй]$/, '');
            pattern = new RegExp(` ${[...words.slice(0, -1), stem].join(' ')}[а-я]{0,3} `);
        }
        matcherCache.set(name, pattern);
    }
    return matcherCache.get(name);
}

// Wineries named in the given texts, at most `max`.
function findWineriesInTexts(texts, list = loadWineries(), max = 2) {
    const haystack = ` ${normalizeName((Array.isArray(texts) ? texts : [texts]).join(' '))} `;
    const found = [];
    for (const w of list) {
        if (w.names.some((n) => haystack.includes(` ${n} `) || (nameMatcher(n) && nameMatcher(n).test(haystack)))) found.push(w);
        if (found.length >= max) break;
    }
    return found;
}

module.exports = { WINERY_CTA_TYPES, ALIASES, normalizeName, buildWineries, loadWineries, findWineriesInTexts, isEnabled, wineryId };
