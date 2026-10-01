'use strict';

// Operator promotions as a bounded soft boost among ELIGIBLE candidates of
// the existing recommendWine() ranking. Order (never changes):
//   user request → parsed preferences (the engine's own) → organic ranking
//   → per promotion: rule applicability → hard constraints on VERIFIED facts
//   → organic-equivalent score + bounded boost → hypothetical ranking.
//
// Hard constraints for a promoted wine (promotion never makes an unsuitable
// wine eligible): requested colour / sweetness must be verified equal;
// with a budget the price must be verified and ≤ budget (unknown → no boost);
// a wine or winery the user excluded is never promoted.
// Mode: off → nothing runs; shadow → computed + recorded, organic returned
// unchanged; on → the hypothetical ranking is used.

const DEFAULT_PROMOTION_BOOST = 8; // organic scale: colour 20, food 15, sweetness 12, body 10, budget 10
const MAX_PROMOTION_BOOST = 20;
const MODES = Object.freeze(['off', 'shadow', 'on']);
const SWEETNESS_LEVEL = Object.freeze({ dry: 1, semi_dry: 2, semi_sweet: 3, sweet: 3 });

function clampBoost(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_PROMOTION_BOOST;
    return Math.max(0, Math.min(MAX_PROMOTION_BOOST, n));
}

function normalize(value) {
    return String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9а-яё]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

// "кроме Purcari", "без Cricova", "не Castel Mimi", "except X", "fără X".
function isExcludedByUser(question, facts) {
    const q = ` ${normalize(question)} `;
    const names = [facts.wineName, facts.wineryName, facts.displayName].map(normalize).filter((n) => n.length >= 4);
    return names.some((name) => new RegExp(` (кроме|без|не|исключая|except|not|no|without|fara|in afara de) (вин[а-я]* |wine )?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `).test(q));
}

// Request conditions the operator attached to the promotion must be asked
// for explicitly: "для белых сухих и к рыбе" applies to a dry-white request
// OR to a fish request (style group / food group); a promotion without
// conditions applies to any request (hard constraints still decide).
function ruleApplies(appliesWhen = {}, prefs = {}) {
    const styleKeys = ['color', 'sweetness'].filter((k) => appliesWhen[k]);
    const styleOk = styleKeys.length > 0 && styleKeys.every((k) => appliesWhen[k] === prefs[k]);
    const foodOk = Boolean(appliesWhen.food) && appliesWhen.food === prefs.food;
    if (!styleKeys.length && !appliesWhen.food) return null;
    if (styleOk || foodOk) return null;
    if (styleKeys.length && appliesWhen.color && appliesWhen.color !== prefs.color) return 'rule_requires_color';
    if (styleKeys.length && appliesWhen.sweetness && appliesWhen.sweetness !== prefs.sweetness) return 'rule_requires_sweetness';
    return 'rule_requires_food';
}

function hardConstraintFailure(facts, prefs, question) {
    if (!facts) return 'facts_unavailable';
    if (isExcludedByUser(question, facts)) return 'user_excluded';
    if (prefs.color && facts.color !== prefs.color) return facts.color ? 'color_mismatch' : 'color_unverified';
    if (prefs.sweetness && facts.sweetness !== prefs.sweetness) return facts.sweetness ? 'sweetness_mismatch' : 'sweetness_unverified';
    if (prefs.budget) {
        if (facts.price == null) return 'price_unknown_with_budget';
        if (facts.price > prefs.budget) return 'over_budget';
    }
    return null;
}

// Organic-equivalent relevance from verified facts only, through the
// engine's own scorer (so promoted and organic candidates share one scale).
// A food match counts only when the catalog record itself lists it
// (operator text saying "good with fish" is not a verified fact).
const FOOD_TEXT = Object.freeze({
    fish: /рыб|fish|pe[sș]te/i, beef: /говяд|стейк|beef|steak|vit[ăa]/i, lamb: /баран|ягн|lamb|miel/i,
    pork: /свин|pork|porc/i, poultry: /птиц|куриц|утк|chicken|duck|poultry|pui|ra[țt][ăa]/i,
    fresh_cheese: /сыр|cheese|br[âa]nz/i, mushroom: /гриб|mushroom|ciuperc/i, vegetable: /овощ|салат|vegetable|salad|legum/i,
});
function verifiedFoods(facts, prefs) {
    if (!prefs.food || !FOOD_TEXT[prefs.food]) return [];
    return (facts.foodPairings || []).some((f) => FOOD_TEXT[prefs.food].test(String(f))) ? [prefs.food] : [];
}

function organicEquivalentScore(facts, prefs, scoreWineCandidate) {
    const style = { color: facts.color, sweetness: SWEETNESS_LEVEL[facts.sweetness] || null, body: null, foods: verifiedFoods(facts, prefs) };
    // Body is not in the catalog record: never scored as if verified.
    const { body, ...scoredPrefs } = prefs;
    return scoreWineCandidate({ style, price: facts.price }, scoredPrefs);
}

function candidateFromFacts(facts, scored, promo, boost) {
    return {
        name: facts.displayName || facts.wineName,
        style: [facts.color, facts.sweetness].filter(Boolean).join(' · ') || null,
        producer: facts.wineryName || null,
        grapes: facts.grapes,
        region: facts.region ? [facts.region] : [],
        price: facts.price,
        score: scored.score + boost,
        matches: scored.matches,
        source: 'promoted',
        promotion_id: promo.promotionId,
        wine_id: facts.wineId,
    };
}

// organicSorted: ALL organic candidates sorted desc (recommendWine's list).
// Returns { ranked, decision } where ranked is what the user gets.
function applyPromotions({ question, prefs, organicSorted, promotions = [], factsById = new Map(), mode = 'off', boost = DEFAULT_PROMOTION_BOOST, scoreWineCandidate, topN = 3 }) {
    const organicTop = organicSorted.slice(0, topN);
    if (mode === 'off' || !promotions.length || !organicSorted.length) return { ranked: organicTop, decision: null };
    const b = clampBoost(boost);
    const evaluations = [];
    const merged = organicSorted.map((c) => ({ ...c }));
    for (const promo of promotions) {
        const facts = factsById.get(promo.wineId) || null;
        const evaluation = {
            promotion_id: promo.promotionId,
            wine_id: promo.wineId,
            name: facts ? (facts.displayName || facts.wineName) : promo.wineName,
            eligible: false,
            exclusion_reason: null,
            organic_score: null,
            boost: 0,
            hypothetical_score: null,
        };
        const reason = ruleApplies(promo.appliesWhen, prefs) || hardConstraintFailure(facts, prefs, question);
        if (reason) { evaluation.exclusion_reason = reason; evaluations.push(evaluation); continue; }
        const scored = organicEquivalentScore(facts, prefs, scoreWineCandidate);
        // The same wine may already be an organic candidate: boost that entry.
        const existing = merged.find((c) => normalize(c.name) === normalize(facts.displayName) || normalize(c.name) === normalize(facts.wineName));
        const organicScore = existing ? existing.score : scored.score;
        if (organicScore <= 0) { evaluation.exclusion_reason = 'not_relevant'; evaluation.organic_score = organicScore; evaluations.push(evaluation); continue; }
        evaluation.eligible = true;
        evaluation.organic_score = organicScore;
        evaluation.boost = b;
        evaluation.hypothetical_score = organicScore + b;
        if (existing) Object.assign(existing, { score: organicScore + b, source: 'promoted', promotion_id: promo.promotionId, wine_id: facts.wineId });
        else merged.push(candidateFromFacts(facts, scored, promo, b));
        evaluations.push(evaluation);
    }
    // Stable sort: on equal score the organic order is kept (organic first).
    const hypothetical = merged.map((c, i) => ({ c, i })).sort((x, y) => (y.c.score - x.c.score) || (x.i - y.i)).map((x) => x.c).slice(0, topN);
    const key = (list) => list.map((c) => normalize(c.name)).join('|');
    for (const e of evaluations) {
        const pos = hypothetical.findIndex((c) => c.promotion_id === e.promotion_id);
        e.hypothetical_position = pos >= 0 ? pos + 1 : null;
    }
    const decision = {
        mode,
        boost: b,
        organic_winner: organicTop[0] ? organicTop[0].name : null,
        organic_winner_score: organicTop[0] ? organicTop[0].score : null,
        hypothetical_winner: hypothetical[0] ? hypothetical[0].name : null,
        ranking_changed: key(hypothetical) !== key(organicTop),
        promotions: evaluations,
    };
    return { ranked: mode === 'on' ? hypothetical : organicTop, decision };
}

module.exports = { applyPromotions, hardConstraintFailure, ruleApplies, isExcludedByUser, clampBoost, DEFAULT_PROMOTION_BOOST, MAX_PROMOTION_BOOST, MODES };
