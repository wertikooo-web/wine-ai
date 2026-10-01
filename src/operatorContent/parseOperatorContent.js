'use strict';

// Save-time parsing of operator text (never on the conversation hot path, no
// LLM call). Operator text is DATA: it is split into lines, named wines and
// wineries are resolved against the verified catalog, and only structured
// results are kept:
//   recommendations → promotions [{ promotionId, wineId, appliesWhen }]
//   news            → items [{ newsId, text, entities, topics, stems }]
// Claims in the text (prices, awards, "the best") are never extracted into
// facts; instruction-like wording has no effect on behaviour and is reported.

const { parseRecommendationPreferences } = require('../knowledge/wineIntelligence');
const { resolveWineMentions } = require('../companion/companionWineFacts');
const { getIndexSync, normalizeName } = require('../companion/companionCatalog');
const wineryLinks = require('../companion/wineryLinks');

const MAX_TEXT = 10000;
const MAX_LINES = 80;
const INSTRUCTION_LIKE = /(ignore\s+(all|previous|the)|disregard|system\s+prompt|you\s+are\s+now|always\s+recommend|never\s+recommend|игнорир|забудь|всегда\s+рекомендуй|никогда\s+не\s+рекомендуй|системн\w*\s+промпт|ignor[ăa]\s+(toate|instruc))/i;

function splitLines(text) {
    return String(text || '').slice(0, MAX_TEXT).split(/\r?\n/)
        .map((line) => line.replace(/^\s*(?:[-•*·]|\d+[.)])\s*/, '').trim())
        .filter(Boolean)
        .slice(0, MAX_LINES);
}

// Request conditions a line attaches to its promotion ("для красных сухих",
// "к рыбе"): the same parser the engine uses for the user's request, so the
// vocabulary cannot drift. Budget is never taken from operator text.
function lineConditions(line) {
    const prefs = parseRecommendationPreferences(line);
    const out = {};
    if (prefs.color) out.color = prefs.color;
    if (prefs.sweetness) out.sweetness = prefs.sweetness;
    if (prefs.food) out.food = prefs.food;
    return out;
}

function looksLikeName(line) {
    return /[A-ZĂÂÎȘŞȚŢ][a-zăâîșşțţ]{2,}/.test(line) || /«[^»]+»|"[^"]+"/.test(line);
}

// Winery names known to the verified wine catalog (whole words, ≥4 chars).
function catalogWineriesIn(line, index) {
    const haystack = ` ${normalizeName(line)} `;
    const out = new Set();
    for (const entry of index) {
        const name = normalizeName(entry.wineryName || '');
        if (name.length >= 4 && haystack.includes(` ${name} `)) out.add(entry.wineryName);
    }
    return [...out];
}

function parseRecommendations(rawText, { index = getIndexSync(), wineries = wineryLinks.loadWineries(), version = 0 } = {}) {
    const lines = splitLines(rawText);
    const report = [];
    const promotions = new Map(); // wineId -> promotion
    const wineryConditions = []; // [{ wineryNames, conditions, line }]
    lines.forEach((line, i) => {
        const entry = { line: i + 1, text: line.slice(0, 160), status: 'ignored_text', warnings: [] };
        if (INSTRUCTION_LIKE.test(line)) entry.warnings.push('instruction_like_text_ignored');
        const mentions = resolveWineMentions(line, index);
        const conditions = lineConditions(line);
        const resolved = mentions.filter((m) => m.status === 'resolved');
        const ambiguous = mentions.filter((m) => m.status === 'ambiguous');
        if (resolved.length) {
            entry.status = 'resolved';
            entry.wines = resolved.map((m) => ({ wineId: m.wineId, wineName: m.wineName, wineryName: m.wineryName }));
            for (const m of resolved) {
                const prev = promotions.get(m.wineId);
                promotions.set(m.wineId, {
                    promotionId: `rec_v${version + 1}_${m.wineId}`,
                    wineId: m.wineId,
                    wineName: m.wineName,
                    wineryName: m.wineryName,
                    appliesWhen: { ...(prev ? prev.appliesWhen : {}), ...conditions },
                    line: i + 1,
                });
            }
        }
        if (ambiguous.length) {
            entry.status = resolved.length ? 'partially_resolved' : 'ambiguous';
            entry.ambiguous = ambiguous.map((m) => ({ matched: m.matched, candidates: m.candidates }));
        }
        if (!resolved.length && !ambiguous.length) {
            const named = [...wineryLinks.findWineriesInTexts([line], wineries, 3).map((w) => w.name), ...catalogWineriesIn(line, index)];
            if (named.length) {
                entry.status = Object.keys(conditions).length ? 'winery_conditions' : 'winery_without_wine';
                entry.wineries = [...new Set(named)];
                wineryConditions.push({ wineryNames: entry.wineries.map((n) => normalizeName(n)), conditions, line: i + 1 });
            } else if (looksLikeName(line)) {
                entry.status = 'unresolved';
            }
        }
        if (Object.keys(conditions).length) entry.conditions = conditions;
        report.push(entry);
    });
    // "Căinari учитывать для красных сухих": a winery line refines the
    // conditions of that winery's promoted wines named elsewhere in the text.
    // It never promotes a winery's whole catalogue on its own.
    for (const rule of wineryConditions) {
        for (const promo of promotions.values()) {
            const winery = normalizeName(promo.wineryName || '');
            if (rule.wineryNames.some((n) => winery && (winery.includes(n) || n.includes(winery)))) {
                promo.appliesWhen = { ...promo.appliesWhen, ...rule.conditions };
            }
        }
    }
    return {
        promotions: [...promotions.values()],
        lines: report,
        counts: {
            lines: lines.length,
            promoted: promotions.size,
            ambiguous: report.filter((r) => r.status === 'ambiguous').length,
            unresolved: report.filter((r) => r.status === 'unresolved').length,
        },
    };
}

// ---------------------------------------------------------------------
// News
// ---------------------------------------------------------------------

const TOPICS = Object.freeze({
    tasting: /дегустац|degust|tasting/i,
    tour: /экскурс|\bтур\w*|поездк|посещ|excursi|\btour|visit|vizit|vizita/i,
    event: /событ|фестивал|ярмарк|праздник|festival|event|eveniment|t[âa]rg|s[ăa]rb[ăa]to/i,
    new_wine: /новинк|нов\w*\s+вин|запуст|выпуст|релиз|lansa|lansare|vin\w*\s+no[iu]|new\s+wine|launch|release/i,
    offer: /скидк|акци|предложен|ofert|reducer|discount|promo/i,
    hours: /часы\s+работ|график|открыт|закрыт|program(ul)?\s+de\s+lucru|opening|hours|deschis|[iî]nchis/i,
});
const NEWS_INTENT = /(что\s+нового|нового\s+у|новинк|новост|интересн\w*.{0,30}сейчас|сейчас.{0,30}интересн|what'?s\s+new|anything\s+new|\bnews\b|latest|nout[ăa][țt]i|ce\s+(e|este|mai\s+e)\s+nou|ce\s+nou)/i;
const STOP = new Set(['винодельня', 'винодельни', 'винодельне', 'вино', 'вина', 'wine', 'wines', 'winery', 'crama', 'vinul', 'vinuri', 'который', 'которая', 'также', 'будет', 'with', 'from', 'that', 'this', 'pentru', 'este']);

function stems(text) {
    return [...new Set(normalizeName(text).split(' ')
        .filter((w) => w.length >= 5 && !STOP.has(w))
        .map((w) => w.slice(0, 6)))];
}

function topicsOf(text) {
    return Object.entries(TOPICS).filter(([, re]) => re.test(text)).map(([name]) => name);
}

function entitiesOf(text, { index = getIndexSync(), wineries = wineryLinks.loadWineries() } = {}) {
    const ws = wineryLinks.findWineriesInTexts([text], wineries, 5).map((w) => ({ type: 'winery', id: w.wineryId, name: w.name }));
    const wines = resolveWineMentions(text, index).filter((m) => m.status === 'resolved').slice(0, 5)
        .map((m) => ({ type: 'wine', id: m.wineId, name: m.wineName, wineryName: m.wineryName }));
    return [...ws, ...wines];
}

function parseNews(rawText, { index = getIndexSync(), wineries = wineryLinks.loadWineries(), version = 0 } = {}) {
    // A news item is a paragraph or a bullet line.
    const blocks = String(rawText || '').slice(0, MAX_TEXT).split(/\r?\n\s*\r?\n|\r?\n(?=\s*(?:[-•*·]|\d+[.)])\s)/)
        .map((b) => b.replace(/^\s*(?:[-•*·]|\d+[.)])\s*/, '').replace(/\s+/g, ' ').trim())
        .filter((b) => b.length >= 10)
        .slice(0, 50);
    const items = [];
    const report = [];
    blocks.forEach((text, i) => {
        const entry = { item: i + 1, text: text.slice(0, 160) };
        if (INSTRUCTION_LIKE.test(text)) {
            entry.status = 'rejected_instruction_like';
            report.push(entry);
            return;
        }
        const entities = entitiesOf(text, { index, wineries });
        const topics = topicsOf(text);
        const item = { newsId: `news_v${version + 1}_${i + 1}`, text: text.slice(0, 600), entities, topics, stems: stems(text) };
        items.push(item);
        entry.status = entities.length ? 'indexed' : (topics.length ? 'indexed_topic_only' : 'indexed_text_only');
        entry.entities = entities.map((e) => e.name);
        entry.topics = topics;
        report.push(entry);
    });
    return { items, lines: report, counts: { items: items.length, rejected: report.filter((r) => r.status === 'rejected_instruction_like').length } };
}

module.exports = { parseRecommendations, parseNews, splitLines, topicsOf, stems, entitiesOf, NEWS_INTENT, INSTRUCTION_LIKE };
