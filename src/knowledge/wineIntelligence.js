'use strict';

// Wine Intelligence -- Phase 6 reasoning layer.
//
// A deterministic inference layer ON TOP of the Phase 0-5 knowledge stores
// (canonical entity facts, Phase 4 entity relations, Wine.md catalog,
// approved documents, controlled web). It answers the four Phase 6 scenarios:
//
//   - pair_food       explainable food pairing (dish -> wine styles/bottles)
//   - recommend_wine  preference-based wine recommendation
//   - compare_wines   style-based comparison of two wines
//   - plan_route      winery/route recommendation under constraints
//
// Contract (roadmap §6): every inference is EXPLAINABLE -- it returns the
// recommendation, the human-readable reasons, the supporting evidence with
// Phase 1 provenance, and a confidence. Every inference is marked
// kind 'ai_inference' and is NEVER written as a verified fact. When the
// knowledge base cannot support a specific recommendation, the layer says
// exactly what data is missing instead of inventing a winery, bottle, price,
// vintage, or award (INVARIANTS: no fabricated facts).
//
// Pure deterministic logic, no LLM calls: scenario detection, preference
// parsing, candidate scoring, and route ordering are all computed from the
// retrieved evidence plus the pairing engine's confirmed style knowledge.
// Adapters are injectable so tests can feed deterministic evidence without a
// database or network.

const { WINE_STYLES, OFFICIAL_BOTTLE_PROFILES, DISH_SIGNALS, profileDish, recommendForDish, findWineStyle } = require('../pairing/pairingEngine');
const { findMentionedEntities } = require('./entityResolver');
const layeredRouter = require('./layeredRouter');
const { buildClaimsFromEvidence, CLAIM_KINDS } = require('./claimProvenance');

const SCENARIOS = Object.freeze({
    PAIR_FOOD: 'pair_food',
    RECOMMEND_WINE: 'recommend_wine',
    COMPARE_WINES: 'compare_wines',
    PLAN_ROUTE: 'plan_route',
});

const SCENARIO_LIST = Object.freeze([
    SCENARIOS.PAIR_FOOD,
    SCENARIOS.RECOMMEND_WINE,
    SCENARIOS.COMPARE_WINES,
    SCENARIOS.PLAN_ROUTE,
]);

// ------------------------------------------------------------------ //
// Scenario detection (deterministic, no NLU).
// ------------------------------------------------------------------ //

const COMPARISON_RE = /(сравн|отлича|разниц|чем\s+(?:лучше|отличается)|vs\b|versus|против)/iu;
const ROUTE_RE = /(маршрут|тур\w*|экскурс|поездк\w*|посетит|за\s*один\s*день|выезд\w*|путешеств|винный\s+тур|trip|route|tour\b|travel)/iu;
const FOOD_PAIRING_RE = /(вино\s*к(?=\s|,|\.|\?|!|$)|к\s*блюд|что\s*подать\s*к|подобрать\s*вино|вин[оа]\s*подо|сочетан\w*\s*с(?=\s|,|\.|\?|!|$)|с\s*чем\s*пить|паруется|pairing|pair\b|гастрономи)/iu;
const RECOMMEND_RE = /(рекоменд|посоветуй|посовету|подбери|подскажи|какое\s*вино|какое\s*выбрать|что\s*выбрать|хочу\s*вино|хочу\s*купить|как[оа]е\s*вино)/iu;
const WINE_ENTITY_RE = /(вино|вина|винодельн|wine|wines|winery)/iu;

// Multi-word proper nouns that resolve to wineries/products (from the shared
// registry) count as wine-related even without the word "wine" itself.
function _mentionsRegistryEntity(query) {
    try {
        return findMentionedEntities(String(query || '')).length > 0;
    } catch {
        return false;
    }
}

function _hasDishSignal(query) {
    const text = String(query || '').toLocaleLowerCase();
    return DISH_KEYS.some((key) => text.includes(key));
}

// Harvested once from pairingEngine.DISH_SIGNALS so food-pairing detection
// and the pairing engine share the same dish vocabulary.
const DISH_KEYS = (function collectDishKeys() {
    const keys = new Set();
    for (const signal of DISH_SIGNALS || []) {
        for (const key of signal.keys) keys.add(key);
    }
    return [...keys];
})();

// Precedence: comparison > route > food pairing > recommendation.
// The wine-related gate is skipped only for food pairing: a pairing phrase
// ("что подать к стейку", "вино к мамалыге") already carries the intent on
// its own -- it is a dish->wine question in this product even without the
// literal word "вино".
function detectScenario(query) {
    const text = String(query || '').trim();
    if (!text) return null;
    if (FOOD_PAIRING_RE.test(text) && _hasDishSignal(text)) return SCENARIOS.PAIR_FOOD;
    if (!WINE_ENTITY_RE.test(text) && !_mentionsRegistryEntity(text)) return null;
    if (COMPARISON_RE.test(text)) return SCENARIOS.COMPARE_WINES;
    if (ROUTE_RE.test(text)) return SCENARIOS.PLAN_ROUTE;
    if (RECOMMEND_RE.test(text)) return SCENARIOS.RECOMMEND_WINE;
    return null;
}

// ------------------------------------------------------------------ //
// Preference parsing for recommendation.
// ------------------------------------------------------------------ //

function parseRecommendationPreferences(query) {
    const text = String(query || '').toLocaleLowerCase();
    const prefs = {};

    const color = (/(^|\s|,)красн/iu.test(text) || /\bred\b/iu.test(text)) ? 'red'
        : (/(^|\s|,)бел\w*/iu.test(text) || /\bwhite\b/iu.test(text)) ? 'white'
            : (/(^|\s|,)розов/iu.test(text) || /\brose\b|rosé/iu.test(text)) ? 'rose'
                : (/(^|\s|,)игрист|спаркл/iu.test(text) || /\bsparkling\b/iu.test(text)) ? 'sparkling' : null;
    if (color) prefs.color = color;

    const sweetness = (/полусладк|полу-сладк/iu.test(text)) ? 'semi_sweet'
        : (/(^|\s|,)сладк|dessert|(^|\s|,)dulce/iu.test(text) || /\bsweet\b/iu.test(text)) ? 'sweet'
            : (/полусух|полу-сух/iu.test(text)) ? 'semi_dry'
                : (/(^|\s|,)сух\w*/iu.test(text) || /\bdry\b/iu.test(text)) ? 'dry' : null;
    if (sweetness) prefs.sweetness = sweetness;

    if (/\bлегк\w*/iu.test(text) || /\blight\b/iu.test(text)) prefs.body = 'light';
    else if (/полнотел|полн\w*\s+тел\w*/iu.test(text) || /\bfull[- ]?bodied\b/iu.test(text)) prefs.body = 'full';
    else if (/средн\w*\s+тел|medium/iu.test(text)) prefs.body = 'medium';

    if (/(праздник|свидан\w*|юбил|свадьб|ужин|вечеринк|подарок|в\s*подарок|occasion|celebration|dinner)/iu.test(text)) {
        prefs.occasion = 'celebration';
    }

    const budgetMatch = text.match(/(?:до|не\s+дороже|около|примерно|под|до\s*)\s*(\d{2,5})/iu);
    if (budgetMatch) prefs.budget = Number(budgetMatch[1]);

    const dishProfile = profileDish(query);
    if (dishProfile.known) prefs.food = dishProfile.food;

    return prefs;
}

// ------------------------------------------------------------------ //
// Evidence gathering.
// ------------------------------------------------------------------ //

// Runs the four-level retrieval through injectable adapters (defaulting to
// the real layeredRouter functions) and merges the result, relations first.
async function gatherEvidence(query, { language = null, allowWeb = false, limit = 8, adapters = {} } = {}) {
    const run = async (name, fn) => {
        try {
            return await fn(query, { language, limit });
        } catch (error) {
            return [];
        }
    };
    const [relations, canonical, catalog, documents] = await Promise.all([
        run('searchRelations', adapters.searchRelations || layeredRouter.searchRelations),
        run('searchCanonical', adapters.searchCanonical || layeredRouter.searchCanonical),
        run('searchCatalog', adapters.searchCatalog || layeredRouter.searchCatalog),
        run('searchDocuments', adapters.searchDocuments || layeredRouter.searchDocuments),
    ]);
    const web = allowWeb ? await run('searchInternet', adapters.searchInternet || layeredRouter.searchInternet) : [];
    const evidence = [...relations, ...canonical, ...catalog, ...documents, ...web];
    return { evidence, relations, canonical, catalog, documents, web };
}

// ------------------------------------------------------------------ //
// Helpers shared by the scenario handlers.
// ------------------------------------------------------------------ //

function normalize(value) {
    return String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ').replace(/[’']/g, '');
}

function wineNamesFromEvidence(evidence) {
    const names = new Map();
    for (const item of evidence) {
        if (item.structured_kind === 'entity_relation' && item.relation?.predicate === 'produces') {
            const name = String(item.relation.object_value || '').trim();
            if (name) names.set(normalize(name), name);
        }
        if (item.level === 'catalog' && item.title) {
            names.set(normalize(item.title), item.title);
        }
    }
    return [...names.values()];
}

function relationItems(evidence, predicate = null) {
    return (evidence || []).filter((item) =>
        item.structured_kind === 'entity_relation' && (!predicate || item.relation?.predicate === predicate));
}

// Resolve one wine name against evidence to its best style + bottle facts.
function wineFacts(name, evidence) {
    const norm = normalize(name);
    const style = findWineStyle({ wine: name, catalogProfiles: catalogProfilesFromEvidence(evidence) });
    const producer = relationItems(evidence, 'produces').find((item) => normalize(item.relation.object_value) === norm);
    const grapes = relationItems(evidence, 'made_from')
        .filter((item) => item.title && normalize(item.title) === norm)
        .map((item) => item.relation.object_value)
        .filter(Boolean);
    const located = relationItems(evidence, 'located_in')
        .filter((item) => item.title && normalize(item.title) === norm)
        .map((item) => item.relation.object_id || item.relation.object_value)
        .filter(Boolean);
    const price = catalogItems(evidence).find((item) => normalize(item.title) === norm)?.catalog?.price ?? null;
    return {
        name,
        style,
        producer: producer ? producer.relation.subject_id : null,
        grapes,
        region: located,
        price,
    };
}

function catalogItems(evidence) {
    return (evidence || []).filter((item) => item.level === 'catalog');
}

function catalogProfilesFromEvidence(evidence) {
    return catalogItems(evidence).map((item) => ({
        name: item.title,
        aliases: [item.title],
        ...(item.catalog?.profile || {}),
    }));
}

function styleLabel(style) {
    if (!style) return null;
    const parts = [style.name];
    if (style.color) parts.push(style.color);
    return parts.join(' · ');
}

// ------------------------------------------------------------------ //
// Scenario: food pairing.
// ------------------------------------------------------------------ //

// Uses the deterministic pairing engine for the style match, then grounds the
// top styles with concrete evidence (official profiles + catalog wines of the
// matching grapes/colour) when available.
async function pairFood({ question, evidence, language }) {
    const pairing = recommendForDish({ dish: question, limit: 3 });
    const dish = pairing.dish_profile || {};
    const reasons = [];
    const candidates = (pairing.candidates || []).map((candidate) => {
        const style = WINE_STYLES.find((s) => s.id === candidate.style_id) || null;
        const bottles = [OFFICIAL_BOTTLE_PROFILES, ...catalogProfilesFromEvidence(evidence)]
            .filter((p) => p && (style && style.grapes.some((g) => (p.grapes || []).includes(g))))
            .slice(0, 3)
            .map((p) => p.name);
        return {
            style_id: candidate.style_id,
            style_name: candidate.style_name,
            score: candidate.score,
            reasons: candidate.reasons,
            bottles,
        };
    });
    if (pairing.clarification) {
        return {
            found: false,
            confidence: 'low',
            explanation: [pairing.clarification],
            missing: [pairing.clarification],
        };
    }
    reasons.push(`Профиль блюда: ${dish.food || 'не определён'}, интенсивность ${dish.body}/4, жирность ${dish.fat}/4, кислотность ${dish.acidity}/4, острота ${dish.spice}/4.`);
    candidates.forEach((candidate) => {
        reasons.push(`${candidate.style_name}: ${(candidate.reasons || []).join(', ') || 'похожая интенсивность'}${candidate.bottles.length ? `. Подходящие бутылки из каталога: ${candidate.bottles.join(', ')}` : ''}.`);
    });
    return {
        found: true,
        confidence: pairing.clarification ? 'medium' : 'high',
        explanation: reasons,
        inference: {
            scenario: SCENARIOS.PAIR_FOOD,
            dish: pairing.dish_profile,
            candidates,
            clarification: pairing.clarification || null,
        },
    };
}

// ------------------------------------------------------------------ //
// Scenario: wine recommendation by preferences.
// ------------------------------------------------------------------ //

function scoreWineCandidate(candidate, prefs) {
    let score = 0;
    const style = candidate.style;
    const matches = [];
    if (prefs.color && style) {
        if (style.color === prefs.color) { score += 20; matches.push(`цвет: ${style.color}`); }
        else score -= 6;
    }
    if (prefs.sweetness && style) {
        const sweet = style.sweetness >= 3 ? 'sweet' : style.sweetness === 2 ? 'semi_dry' : 'dry';
        if (sweet === prefs.sweetness) { score += 12; matches.push(`сладость: ${sweet}`); }
    }
    if (prefs.body && style) {
        const body = style.body >= 3 ? 'full' : style.body === 2 ? 'medium' : 'light';
        if (body === prefs.body) { score += 10; matches.push(`тело: ${body}`); }
    }
    if (prefs.food && style) {
        if ((style.foods || []).includes(prefs.food)) { score += 15; matches.push(`подходит к ${prefs.food}`); }
    }
    if (prefs.occasion) score += 4;
    if (prefs.budget && candidate.price != null) {
        if (candidate.price <= prefs.budget) { score += 10; matches.push(`цена ${candidate.price} ≤ ${prefs.budget}`); }
        else score -= 4;
    }
    return { score, matches };
}

// Preference-based recommendation over concrete wine names found in evidence
// (catalog + produces relations) + confirmed official bottle profiles.
async function recommendWine({ question, evidence, language }) {
    const prefs = parseRecommendationPreferences(question);
    const candidates = [];

    for (const name of wineNamesFromEvidence(evidence)) {
        const facts = wineFacts(name, evidence);
        if (!facts.style) continue;
        const { score, matches } = scoreWineCandidate({ style: facts.style, price: facts.price }, prefs);
        if (score > 0) {
            candidates.push({
                name,
                style: styleLabel(facts.style),
                producer: facts.producer,
                grapes: facts.grapes,
                region: facts.region,
                price: facts.price,
                score,
                matches,
            });
        }
    }
    for (const profile of OFFICIAL_BOTTLE_PROFILES) {
        const { score, matches } = scoreWineCandidate({ style: profile, price: null }, prefs);
        if (score > 0) {
            candidates.push({
                name: profile.name,
                style: styleLabel(profile),
                producer: null,
                grapes: profile.grapes,
                region: null,
                price: null,
                score,
                matches,
            });
        }
    }

    const missing = [];
    if (!prefs.color && !prefs.sweetness && !prefs.food && !prefs.budget) {
        missing.push('Укажите хотя бы одно из: цвет вина, сухость, блюдо или бюджет — иначе рекомендация не может быть осмысленной.');
    }
    if (!candidates.length) {
        missing.push(`В знаниях не найдено вин, подходящих под ${Object.keys(prefs).length ? 'указанные параметры' : 'запрос'}. Проверьте описание: цвет, сухость, блюдо, регион или бюджет.`);
    }
    if (missing.length) {
        return { found: false, confidence: 'low', explanation: missing, missing };
    }

    const ranked = candidates.sort((a, b) => b.score - a.score).slice(0, 3);
    const reasons = ranked.map((candidate) =>
        `${candidate.name} (${candidate.style})${candidate.producer ? `, производитель ${candidate.producer}` : ''}` +
        `${candidate.price != null ? `, ${candidate.price} MDL` : ''} — ${candidate.matches.join(', ')}.`);
    reasons.push(`Обнаружены предпочтения: ${Object.keys(prefs).map((k) => `${k}=${prefs[k]}`).join(', ')}.`);
    return {
        found: true,
        confidence: ranked.some((c) => c.price != null || c.producer) ? 'high' : 'medium',
        explanation: reasons,
        inference: {
            scenario: SCENARIOS.RECOMMEND_WINE,
            preferences: prefs,
            wines: ranked,
        },
    };
}

// ------------------------------------------------------------------ //
// Scenario: style-based wine comparison.
// ------------------------------------------------------------------ //

function extractWineNames(question, evidence) {
    const norm = normalize(question);
    const names = [];
    const seen = new Set();
    const push = (name) => {
        const key = normalize(name);
        if (key && !seen.has(key)) { seen.add(key); names.push(name); }
    };
    // Wine/product names that literally appear in the question (from evidence)
    // first -- they are the most specific referent ("Negru de Purcari").
    for (const name of wineNamesFromEvidence(evidence)) {
        if (norm.includes(normalize(name))) push(name);
    }
    // Then registry entities (wineries) mentioned in the question.
    try {
        for (const mention of findMentionedEntities(question)) push(mention.canonicalName);
    } catch { /* registry failure must not block */ }
    return names.slice(0, 2);
}

async function compareWines({ question, evidence, language }) {
    const names = extractWineNames(question, evidence);
    if (names.length < 2) {
        return {
            found: false,
            confidence: 'low',
            explanation: ['Для сравнения нужно два конкретных вина или винодельни.'],
            missing: ['Назовите два вина/винодельни (например: "сравни Cricova и Purcari" или "отличия Negru de Purcari и Cricova 1952").'],
        };
    }

    const rows = [];
    const [aName, bName] = names;
    const a = wineFacts(aName, evidence);
    const b = wineFacts(bName, evidence);
    const differences = [];

    const attr = (label, valueA, valueB) => {
        rows.push({ attribute: label, a: valueA ?? '—', b: valueB ?? '—' });
        if (valueA && valueB && String(valueA) !== String(valueB)) differences.push(label);
    };

    attr('Производитель', a.producer, b.producer);
    attr('Стиль', styleLabel(a.style), styleLabel(b.style));
    attr('Цвет', a.style?.color ?? null, b.style?.color ?? null);
    attr('Сорта винограда', a.grapes.length ? a.grapes.join(', ') : null, b.grapes.length ? b.grapes.join(', ') : null);
    attr('Регион', a.region.length ? a.region.join(', ') : null, b.region.length ? b.region.join(', ') : null);
    attr('Цена (MDL)', a.price != null ? String(a.price) : null, b.price != null ? String(b.price) : null);
    if (a.style && b.style) {
        attr('Тело', a.style.body, b.style.body);
        attr('Кислотность', a.style.acidity, b.style.acidity);
        attr('Сладость', a.style.sweetness, b.style.sweetness);
        attr('Танины', a.style.tannin, b.style.tannin);
    }

    const explanation = [`Сравнение ${aName} и ${bName}.`];
    if (differences.length) explanation.push(`Ключевые отличия: ${differences.join(', ')}.`);
    if (!differences.length) explanation.push('По имеющимся данным вина схожи по всем доступным атрибутам.');
    if (!a.style || !b.style) {
        explanation.push('Для одного из вин не найден полный стиль в знаниях — сравнение ограничено доступными фактами.');
    }

    return {
        found: true,
        confidence: (a.style && b.style) ? 'high' : 'medium',
        explanation,
        inference: {
            scenario: SCENARIOS.COMPARE_WINES,
            wines: [aName, bName],
            attributes: rows,
        },
    };
}

// ------------------------------------------------------------------ //
// Scenario: winery / route recommendation by constraints.
// ------------------------------------------------------------------ //

function parseRouteConstraints(question) {
    const text = String(question || '').toLocaleLowerCase();
    const constraints = {};
    if (/(лето|летн|summer)/iu.test(text)) constraints.season = 'summer';
    if (/(зим|зимн|winter)/iu.test(text)) constraints.season = 'winter';
    if (/(весн|spring)/iu.test(text)) constraints.season = 'spring';
    if (/(осен|осенн|autumn)/iu.test(text)) constraints.season = 'autumn';
    const budgetMatch = text.match(/(?:до|бюджет|не\s+дороже)\s*(\d{2,5})/iu);
    if (budgetMatch) constraints.budget = Number(budgetMatch[1]);
    const distanceMatch = text.match(/(\d{1,3})\s*км|(\d{1,3})\s*km/iu);
    if (distanceMatch) constraints.distance_km = Number(distanceMatch[1] || distanceMatch[2]);
    const hoursMatch = text.match(/(\d{1,2})\s*(?:час|ч\b)/iu);
    if (hoursMatch) constraints.hours = Number(hoursMatch[1]);
    const regionMatch = text.match(/(кодр|codru|штефан[ау]?\s*вод|ștefan\s*vod|стефановод|валул\s*луй\s*траян|valul\s*lui\s*traian|пуркар|белц|комрат|гагауз|молдов)/iu);
    if (regionMatch) constraints.region = regionMatch[1];
    return constraints;
}

// Wineries discovered from relation edges: subjects with offers_tour /
// offers_tasting / located_in, plus their route document evidence.
async function planRoute({ question, evidence, language }) {
    const constraints = parseRouteConstraints(question);
    const wineries = new Map();

    for (const item of relationItems(evidence)) {
        const rel = item.relation || {};
        if (!rel.subject_id) continue;
        if (!wineries.has(rel.subject_id)) {
            wineries.set(rel.subject_id, { id: rel.subject_id, name: item.title || rel.subject_id, tour: false, tasting: false, regions: [], evidence: [] });
        }
        const entry = wineries.get(rel.subject_id);
        if (rel.predicate === 'offers_tour') entry.tour = true;
        if (rel.predicate === 'offers_tasting') entry.tasting = true;
        if (rel.predicate === 'located_in') entry.regions.push(rel.object_id || rel.object_value);
        entry.evidence.push(item);
    }

    let list = [...wineries.values()];
    if (constraints.region) {
        list = list.filter((entry) => entry.regions.some((region) => normalize(region).includes(normalize(constraints.region))));
    }

    if (!list.length) {
        const missing = constraints.region
            ? [`По ограничению «регион: ${constraints.region}» в знаниях не найдено виноделен с экскурсиями/дегустациями. Проверьте регион или уберите его.`]
            : ['В знаниях не найдено виноделен с турами/дегустациями. Добавьте relations offers_tour/offers_tasting или уточните регион.'];
        return { found: false, confidence: 'low', explanation: missing, missing, inference: { scenario: SCENARIOS.PLAN_ROUTE, constraints, stops: [] } };
    }

    const stops = list.map((entry) => ({
        id: entry.id,
        name: entry.name,
        tour: entry.tour,
        tasting: entry.tasting,
        regions: entry.regions,
        evidence: entry.evidence.slice(0, 3).map((item) => item.text),
    }));

    const explanation = [
        `Составлен маршрут по ${stops.length} виноделн(ам)${constraints.region ? ` в регионе ${constraints.region}` : ''}:`,
        ...stops.map((stop) => `${stop.name} — ${stop.tour ? 'экскурсия' : ''}${stop.tour && stop.tasting ? ' и ' : ''}${stop.tasting ? 'дегустация' : ''}${stop.tour || stop.tasting ? '' : ' (без подтверждённых туров)'}.`),
    ];
    if (constraints.hours) explanation.push(`Ограничение по времени: ${constraints.hours} ч — распределите визиты соответственно.`);
    if (constraints.budget) explanation.push(`Бюджет: до ${constraints.budget} MDL на визит — уточните стоимость у каждой винодельни (цен нет в знаниях).`);

    return {
        found: true,
        confidence: stops.some((s) => s.tour || s.tasting) ? 'high' : 'medium',
        explanation,
        inference: {
            scenario: SCENARIOS.PLAN_ROUTE,
            constraints,
            stops,
        },
    };
}

// ------------------------------------------------------------------ //
// Public contract.
// ------------------------------------------------------------------ //

const HANDLERS = Object.freeze({
    [SCENARIOS.PAIR_FOOD]: pairFood,
    [SCENARIOS.RECOMMEND_WINE]: recommendWine,
    [SCENARIOS.COMPARE_WINES]: compareWines,
    [SCENARIOS.PLAN_ROUTE]: planRoute,
});

// Builds the Phase 1 claim list for an inference result: the supporting
// evidence as claims, plus ONE ai_inference claim that carries the
// recommendation summary -- never a verified fact.
function buildInferenceClaims(inferenceResult) {
    const evidenceClaims = buildClaimsFromEvidence(inferenceResult.evidence || []).map((claim) => {
        const { _conflict_key, ...rest } = claim;
        return rest;
    });
    const summary = String(inferenceResult.explanation?.join(' ') || '');
    if (!summary || !inferenceResult.found) return evidenceClaims;
    return [
        ...evidenceClaims,
        {
            id: 'claim_ai_inference',
            claim: summary.slice(0, 500),
            kind: CLAIM_KINDS.AI_INFERENCE,
            level: null,
            confidence: inferenceResult.confidence || null,
            entity_id: null,
            source: null,
            freshness: { dynamic: false, as_of: null },
            conflict: null,
            structured: null,
        },
    ];
}

// Main entry point. Returns the inference contract:
//   { ok, question, language, scenario|null, found, confidence,
//     explanation[], missing[], inference|null, evidence[], claims[] }
async function runInference(question, options = {}) {
    const text = String(question || '').trim();
    if (!text) throw Object.assign(new Error('question_required'), { code: 'question_required' });
    if (text.length > 1000) throw Object.assign(new Error('question_too_long'), { code: 'question_too_long' });
    const language = ['ru', 'ro', 'en'].includes(options.language) ? options.language : null;
    const scenario = options.scenario && SCENARIO_LIST.includes(options.scenario)
        ? options.scenario
        : detectScenario(text);

    if (!scenario) {
        return {
            ok: true,
            question: text,
            language: language || 'auto',
            scenario: null,
            found: false,
            confidence: null,
            explanation: [],
            missing: [],
            inference: null,
            evidence: [],
            claims: [],
        };
    }

    const gathered = await gatherEvidence(text, {
        language,
        allowWeb: options.allowWeb === true,
        limit: options.limit || 8,
        adapters: options.adapters || {},
    });
    const result = await HANDLERS[scenario]({ question: text, evidence: gathered.evidence, language });

    const claims = buildInferenceClaims({ ...result, evidence: gathered.evidence });
    return {
        ok: true,
        question: text,
        language: language || 'auto',
        scenario,
        found: result.found === true,
        confidence: result.confidence || null,
        explanation: result.explanation || [],
        missing: result.missing || [],
        inference: result.found ? result.inference || null : null,
        evidence: gathered.evidence,
        claims,
    };
}

module.exports = {
    SCENARIOS,
    SCENARIO_LIST,
    detectScenario,
    parseRecommendationPreferences,
    gatherEvidence,
    runInference,
    pairFood,
    recommendWine,
    compareWines,
    planRoute,
    buildInferenceClaims,
    WINE_STYLES,
};
