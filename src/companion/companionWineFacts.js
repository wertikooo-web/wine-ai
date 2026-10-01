'use strict';

// Structured wine facts by canonical id, from the verified partner catalog
// (companion_wines: WineMD products imported by scripts/import-companion-wines.js).
//
// One small reusable adapter, not a second wine model: it projects the
// existing companion record onto the fields the recommendation engine scores
// on (colour, sweetness, price, grapes, food pairings) and nothing else.
// Used today by the operator promotion layer; the organic recommendWine()
// can use the same adapter later (docs/RECOMMENDATION_CATALOG_GAP.md).
//
// Values are only what the record states. Unknown stays null: a caller that
// needs a verified fact must treat null as "not verified", never guess.

const { getCompanionStore, getIndexSync, normalizeName } = require('./companionCatalog');

// companion `type` is free text from WineMD (mostly Russian: «красное»,
// «белое», «розовое», «сладкое», «коллекционное»); EN/RO spellings accepted.
const COLOR_BY_TYPE = [
    [/красн|^red\b|\bred\b|ro[sș]u|rosie/i, 'red'],
    [/бел|white|\balb/i, 'white'],
    [/розов|ros[eé]\b|\broz/i, 'rose'],
    [/игрист|sparkling|spumant|brut/i, 'sparkling'],
];
const SWEETNESS_BY_TEXT = [
    [/полусладк|semi[- ]?sweet|demidulce/i, 'semi_sweet'],
    [/полусух|semi[- ]?dry|demisec/i, 'semi_dry'],
    [/сладк|\bsweet\b|dulce|dessert|десерт/i, 'sweet'],
    [/сух|\bdry\b|\bsec\b|brut/i, 'dry'],
];

function firstMatch(table, value) {
    const text = String(value || '').trim();
    if (!text) return null;
    for (const [re, out] of table) if (re.test(text)) return out;
    return null;
}

function colorOf(record) {
    return firstMatch(COLOR_BY_TYPE, record.type);
}

// Explicit `sweetness` wins; a type of «сладкое» states sweetness too.
function sweetnessOf(record) {
    return firstMatch(SWEETNESS_BY_TEXT, record.sweetness) || (/сладк|sweet|dulce/i.test(String(record.type || '')) ? 'sweet' : null);
}

function factsFromRecord(record) {
    if (!record || !record.wineId) return null;
    return {
        wineId: record.wineId,
        wineName: record.wineName || null,
        wineryName: record.wineryName || null,
        displayName: [record.wineryName, record.wineName].filter(Boolean).join(' ') || record.wineName || null,
        color: colorOf(record),
        sweetness: sweetnessOf(record),
        price: typeof record.price === 'number' && record.price > 0 ? record.price : null,
        currency: record.currency || null,
        vintage: record.vintage || null,
        grapes: Array.isArray(record.grapes) ? record.grapes : [],
        foodPairings: Array.isArray(record.foodPairings) ? record.foodPairings : [],
        region: record.region || null,
    };
}

async function getWineFacts(wineId, { store = getCompanionStore() } = {}) {
    if (!wineId) return null;
    try {
        return factsFromRecord(await store.get(wineId));
    } catch {
        return null;
    }
}

// Catalog wines named in a text, with ambiguity: a matched name shared by
// several published records (e.g. one wine, several vintages) is ambiguous.
function resolveWineMentions(text, index = getIndexSync()) {
    const haystack = ` ${normalizeName(text)} `;
    const byName = new Map();
    for (const entry of index) {
        for (const name of entry.names) {
            if (!haystack.includes(` ${name} `)) continue;
            if (!byName.has(name)) byName.set(name, []);
            byName.get(name).push(entry);
        }
    }
    // Longest matched names first; a shorter name contained in an already
    // matched longer one ("negru de purcari" inside "...purcari negru de
    // purcari") is the same mention.
    const names = [...byName.keys()].sort((a, b) => b.length - a.length);
    const taken = [];
    const out = [];
    for (const name of names) {
        if (taken.some((t) => t.includes(name))) continue;
        taken.push(name);
        const entries = [...new Map(byName.get(name).map((e) => [e.wineId, e])).values()];
        out.push(entries.length === 1
            ? { status: 'resolved', matched: name, wineId: entries[0].wineId, wineName: entries[0].wineName, wineryName: entries[0].wineryName }
            : { status: 'ambiguous', matched: name, candidates: entries.slice(0, 5).map((e) => ({ wineId: e.wineId, wineName: e.wineName, wineryName: e.wineryName })) });
    }
    return out;
}

module.exports = { factsFromRecord, getWineFacts, resolveWineMentions, colorOf, sweetnessOf };
