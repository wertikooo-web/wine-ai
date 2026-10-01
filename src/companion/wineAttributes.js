'use strict';

// Deterministic normalization of wine attributes as wine.md states them
// (product "Характеристики товара" block, catalog category in the URL,
// wine.md's own description). No inference: a value is set only when the
// source states it in a recognized form; otherwise it stays null.
//
// Canonical values:
//   color:     red | white | rose | sparkling
//   sweetness: dry | semi_dry | semi_sweet | sweet
// Every derived value carries its source ("characteristics", "category",
// "description") so it can be audited.

function fold(value) {
    return String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ё/g, 'е').trim();
}

// Order matters: semi-* before the plain words they contain.
const SWEETNESS_LABELS = [
    [/(полусладк|semi[- ]?sweet|demi[- ]?dulce|demidulce)/, 'semi_sweet'],
    [/(полусух|semi[- ]?dry|demi[- ]?sec|demisec)/, 'semi_dry'],
    [/(^|[^а-яa-z])(сладк|десертн|sweet|dulce|dessert)/, 'sweet'],
    [/(^|[^а-яa-z])(сух|брют|dry|sec|brut|extra brut)/, 'dry'],
];

const COLOR_LABELS = [
    [/(игрист|sparkling|spumant|шампан)/, 'sparkling'],
    [/(розов|ros[eé]|roze|rose)/, 'rose'],
    [/(красн|(^|[^a-z])red([^a-z]|$)|ro[sș]u|rosi[ie])/, 'red'],
    [/(бел|(^|[^a-z])white([^a-z]|$)|(^|[^a-z])alb)/, 'white'],
];

const CATEGORY_COLOR = Object.freeze({ 'vinuri-rosii': 'red', 'vinuri-albe': 'white', 'vinuri-roze': 'rose', 'vinuri-spumante': 'sparkling' });
const CATEGORY_SWEETNESS = Object.freeze({ 'vinuri-dulci': 'sweet' });

function fromTable(table, value) {
    const text = fold(value);
    if (!text) return null;
    for (const [re, out] of table) if (re.test(text)) return out;
    return null;
}

// A characteristics label must be the whole value ("Сухое", "Полусладкое"),
// not prose that merely contains the word.
function sweetnessFromLabel(value) {
    const text = fold(value);
    if (!text || text.length > 30) return null;
    return fromTable(SWEETNESS_LABELS, text);
}

function colorFromLabel(value) {
    const text = fold(value);
    if (!text || text.length > 30) return null;
    return fromTable(COLOR_LABELS, text);
}

// wine.md's own description classifies the wine explicitly in a fixed form
// ("Красное сухое вино…", "вино сухое", "полусухое белое"). Prose mentions
// ("сухофрукты", "сухие травы") are not classifications.
const DESCRIPTION_SWEETNESS = [
    [/полусладк[а-я]*\s+(?:красн|бел|розов|вин)|(?:вино|красное|белое|розовое)\s+полусладк/, 'semi_sweet'],
    [/полусух[а-я]*\s+(?:красн|бел|розов|вин)|(?:вино|красное|белое|розовое)\s+полусух/, 'semi_dry'],
    [/(?:^|[^а-я])сух(?:ое|ого|им)\s+(?:красн|бел|розов|вин)|(?:^|[^а-я])(?:вино|красное|белое|розовое)\s+сухое/, 'dry'],
    [/десертн[а-я]*\s+вин|(?:^|[^а-я])сладк(?:ое|ого)\s+(?:красн|бел|розов|вин)|(?:вино|красное|белое)\s+сладкое/, 'sweet'],
];
function sweetnessFromDescription(text) {
    const value = fold(text);
    if (!value) return null;
    const hits = new Set(DESCRIPTION_SWEETNESS.filter(([re]) => re.test(value)).map(([, out]) => out));
    return hits.size === 1 ? [...hits][0] : null; // conflicting statements → unknown
}

function categoryOf(productUrl) {
    const m = String(productUrl || '').match(/\/catalog\/wine\/([^/]+)/);
    return m ? m[1] : null;
}

function parseGrapes(value) {
    return String(value || '').split(/[,/&;+]| и | and | si | și /i)
        .map((g) => g.replace(/\s+/g, ' ').trim())
        .filter((g) => g.length >= 3 && g.length <= 40 && !/^\d/.test(g))
        .slice(0, 6);
}

function parseNumber(value, re) {
    const m = String(value || '').replace(',', '.').match(re);
    return m ? Number(m[1]) : null;
}

// raw = { productUrl, description, characteristics? } → normalized attributes.
function normalizeWineAttributes(raw) {
    const c = (raw && raw.characteristics) || {};
    const category = categoryOf(raw && raw.productUrl);
    const out = { color: null, colorSource: null, sweetness: null, sweetnessSource: null, sweetnessLabel: null, grapes: [], vintage: null, alcohol: null, servingTemperature: null, compatibility: [] };

    const labelColor = colorFromLabel(c.color);
    if (labelColor) { out.color = labelColor; out.colorSource = 'characteristics'; }
    else if (CATEGORY_COLOR[category]) { out.color = CATEGORY_COLOR[category]; out.colorSource = 'category'; }

    const labelSweet = sweetnessFromLabel(c.taste);
    if (labelSweet) { out.sweetness = labelSweet; out.sweetnessSource = 'characteristics'; out.sweetnessLabel = String(c.taste).trim(); }
    else if (CATEGORY_SWEETNESS[category]) { out.sweetness = CATEGORY_SWEETNESS[category]; out.sweetnessSource = 'category'; }
    else {
        const desc = sweetnessFromDescription(raw && raw.description);
        if (desc) { out.sweetness = desc; out.sweetnessSource = 'description'; }
    }

    out.grapes = parseGrapes(c.grapes);
    const year = parseNumber(c.year, /(19\d\d|20\d\d)/);
    if (year) out.vintage = year;
    const alc = parseNumber(c.alcohol, /(\d{1,2}(?:\.\d)?)\s*%/);
    if (alc && alc > 0 && alc < 30) out.alcohol = alc;
    if (c.serving && /\d/.test(c.serving) && String(c.serving).length <= 20) out.servingTemperature = String(c.serving).trim();
    out.compatibility = Array.isArray(c.compatibility) ? c.compatibility.slice(0, 10) : [];
    return out;
}

module.exports = { normalizeWineAttributes, sweetnessFromLabel, colorFromLabel, sweetnessFromDescription, categoryOf, parseGrapes, fold };
