'use strict';

// Fix A: recommendation candidates from the verified wine.md range
// (companion_wines through companionWineFacts), behind
// RECOMMEND_CATALOG_POOL = off | shadow | on (default shadow).
//
// Eligibility uses VERIFIED fields only:
//   colour     requested → must equal (unknown colour: excluded)
//   sweetness  requested → a verified mismatch is excluded; unknown is
//              allowed but scores lower (no sweetness points)
//   budget     requested → a verified price above it is excluded; unknown
//              price is allowed but scores lower (no budget points)
//   food / body: not in the catalog data → never scored as matched
// Scoring is the engine's own scoreWineCandidate on the same scale as the
// organic candidates. At most one wine per winery in the final top 3.

const { getAllFactsSync } = require('../companion/companionWineFacts');

const MODES = Object.freeze(['off', 'shadow', 'on']);
const SWEETNESS_POINTS = 12;
const SWEETNESS_LABELS = Object.freeze({ dry: 'сухое', semi_dry: 'полусухое', semi_sweet: 'полусладкое', sweet: 'сладкое' });
const MAX_PER_WINERY = 1;

function catalogPoolMode(env = process.env) {
    const value = String(env.RECOMMEND_CATALOG_POOL || 'shadow').toLowerCase();
    return MODES.includes(value) ? value : 'shadow';
}

function eligible(facts, prefs) {
    if (prefs.color && facts.color !== prefs.color) return false;
    if (prefs.sweetness && facts.sweetness && facts.sweetness !== prefs.sweetness) return false;
    if (prefs.budget && facts.price != null && facts.price > prefs.budget) return false;
    return true;
}

// Requests the catalog can actually ground: at least a colour, a sweetness
// or a budget (the catalog has no verified food or body data).
function poolApplies(prefs) {
    return Boolean(prefs && (prefs.color || prefs.sweetness || prefs.budget));
}

function catalogCandidates(prefs, scoreWineCandidate, { facts = getAllFactsSync() } = {}) {
    if (!poolApplies(prefs)) return [];
    const { body, food, ...scored } = prefs;
    const out = [];
    for (const f of facts) {
        if (!eligible(f, prefs)) continue;
        // Sweetness is matched here on the VERIFIED value only: the shared
        // scorer reads a missing sweetness as "dry" and cannot tell
        // semi-sweet from sweet. Same +12 as the scorer gives.
        const { sweetness, ...rest } = scored;
        const style = { color: f.color, sweetness: null, body: null, foods: [] };
        const base = scoreWineCandidate({ style, price: f.price }, rest);
        let score = base.score;
        const matches = [...base.matches];
        if (sweetness && f.sweetness === sweetness) { score += SWEETNESS_POINTS; matches.push(`сладость: ${SWEETNESS_LABELS[sweetness]}`); }
        if (score <= 0) continue;
        out.push({
            name: f.displayName || f.wineName,
            style: [f.color, f.sweetness].filter(Boolean).join(' · ') || null,
            producer: f.wineryName || null,
            grapes: f.grapes || [],
            region: f.region ? [f.region] : [],
            price: f.price,
            vintage: f.vintage || null,
            score,
            matches,
            source: 'catalog',
            wine_id: f.wineId,
        });
    }
    return out;
}

function normalizeName(value) {
    return String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9а-я]+/gi, ' ').trim();
}

// Deterministic order: score, then verified completeness (sweetness, price),
// then price closest to 80% of the budget (or the eligible median), then id.
// Organic candidates keep their place on equal scores.
function rankWithCatalog(organicSorted, catalog, prefs, topN = 3) {
    const prices = catalog.map((c) => c.price).filter((p) => p != null).sort((a, b) => a - b);
    // With a budget: around 80% of it (not always the most expensive allowed
    // bottle); without one: the median eligible price.
    const target = prefs.budget ? prefs.budget * 0.8 : (prices.length ? prices[Math.floor(prices.length / 2)] : 0);
    const organicNames = organicSorted.map((c) => normalizeName(c.name));
    // An organic (official-profile) bottle that is the same wine as a catalog
    // row ("Aurelius Merlot 2019" / "Aurelius Winery Aurelius Merlot") keeps
    // the organic entry only.
    const fresh = catalog.filter((c) => {
        const n = normalizeName(c.name);
        return !organicNames.some((o) => o && (n.includes(o.replace(/ \d{4}$/, '')) || o.includes(n)));
    });
    const completeness = (c) => (c.matches.some((m) => /сладост|sweet/i.test(m)) ? 2 : 0) + (c.price != null ? 1 : 0);
    const all = [
        ...organicSorted.map((c, i) => ({ c, organic: true, i })),
        ...fresh.map((c) => ({ c, organic: false, i: 0 })),
    ];
    all.sort((x, y) => (y.c.score - x.c.score)
        || (x.organic === y.organic ? 0 : (x.organic ? -1 : 1))
        || (x.organic ? x.i - y.i : 0)
        || (completeness(y.c) - completeness(x.c))
        || (Math.abs((x.c.price ?? 1e9) - target) - Math.abs((y.c.price ?? 1e9) - target))
        || String(x.c.wine_id).localeCompare(String(y.c.wine_id)));
    const perWinery = new Map();
    const picked = [];
    for (const { c } of all) {
        const winery = normalizeName(c.producer || c.name.split(' ')[0]);
        const n = perWinery.get(winery) || 0;
        if (n >= MAX_PER_WINERY) continue;
        perWinery.set(winery, n + 1);
        picked.push(c);
        if (picked.length >= topN) break;
    }
    return picked;
}

module.exports = { catalogPoolMode, catalogCandidates, rankWithCatalog, eligible, poolApplies, MODES };
