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

const { WINE_STYLES, OFFICIAL_BOTTLE_PROFILES, DISH_SIGNALS, profileDish, recommendForDish } = require('../pairing/pairingEngine');
const { findMentionedEntities } = require('./entityResolver');
const layeredRouter = require('./layeredRouter');
const { classifyWineMdUrl } = require('../kos/sources/wineMdUrlClassifier');
const { buildClaimsFromEvidence, CLAIM_KINDS } = require('./claimProvenance');

// Natural-language labels for internal keys so user-facing explanation text
// never narrates database, search, or retrieval internals (INVARIANTS: voice).
const FOOD_LABELS = {
    fresh_cheese: 'свежий сыр',
    fried: 'жареное блюдо',
    pork: 'свинина',
    beef: 'говядина',
    lamb: 'баранина',
    fish: 'рыба',
    poultry: 'птица',
    mushroom: 'грибное блюдо',
    vegetable: 'овощное блюдо',
};
const COLOR_LABELS = { red: 'красное', white: 'белое', rose: 'розовое', sparkling: 'игристое' };
const SWEETNESS_LABELS = { dry: 'сухое', semi_dry: 'полусухое', semi_sweet: 'полусладкое', sweet: 'сладкое' };
const BODY_LABELS = { light: 'лёгкое', medium: 'средней плотности', full: 'полнотелое' };
// Localized rendering of the pairing engine's reason phrases so the
// explanation stays in the sommelier's voice and language.
const REASON_LABELS = {
    'acidity refreshes the richer texture': 'кислотность освежает плотную текстуру',
    'the lighter tannin keeps heat from becoming harsher': 'лёгкие танины смягчают пряность',
    'its body matches the main ingredient': 'тело совпадает с основным ингредиентом',
    'the wine and dish have a similar intensity': 'вино и блюдо схожи по насыщенности',
};
const labelReason = (reason) => REASON_LABELS[reason] || reason;

function labelFood(key) { return FOOD_LABELS[key] || key; }
function labelColor(key) { return COLOR_LABELS[key] || key; }
function labelSweetness(key) { return SWEETNESS_LABELS[key] || key; }
function labelBody(key) { return BODY_LABELS[key] || key; }

// Human-readable preference summary for a recommendation (voice-safe).
function describePreferences(prefs) {
    const parts = [];
    if (prefs.color) parts.push(labelColor(prefs.color));
    if (prefs.sweetness) parts.push(labelSweetness(prefs.sweetness));
    if (prefs.body) parts.push(labelBody(prefs.body));
    if (prefs.food) parts.push(`под блюдо: ${labelFood(prefs.food)}`);
    if (prefs.occasion) parts.push('на праздник');
    if (prefs.budget) parts.push(`до ${prefs.budget} MDL`);
    return parts.length ? parts.join(', ') : 'без уточнений';
}

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

const COMPARISON_RE = /(сравн|отлич(?:а|ие|ия|ием|ий|иях)|разниц|чем\s+(?:лучше|отличается)|vs\b|versus|против|преимуществ\w*\s+перед)/iu;
const ROUTE_RE = /(маршрут|тур\w*|экскурс|поездк\w*|посетит|за\s*один\s*день|выезд\w*|путешеств|винный\s+тур|trip|route|tour\b|travel|спланируй|план\w*\s+поездк)/iu;
const FOOD_PAIRING_RE = /(вино\s*к(?=\s|,|\.|\?|!|$)|к\s*блюд|(?:что|какое)\s+вино\s+(?:подать|взять)\s+к|что\s+подать\s+к|что\s+взять\s+к|что\s+выпить\s+к|подобрать\s+вино|подойд[её]т\s+к|подходит\s+к|вин[оа]\s+подо|сочетан\w*\s+с(?=\s|,|\.|\?|!|$)|с\s+чем\s+пить|с\s+чем\s+подать|к\s+чему|паруется|pairing|pair\b|гастроном)/iu;
const RECOMMEND_RE = /(рекоменд|посоветуй|посовету|подбери|подскаж|подсказ|какое\s+вино|какое\s+выбрать|какое\s+взять|что\s+выбрать|что\s+взять|что\s+попробовать|вместо|хочу\s+вино|хочу\s+купить|хочу\s+выбрать|хочу\s+подобрать|хочу\s+попробовать|помоги\s+выбрать|помоги\s+подобрать|выбрать\s+вино|подобрать\s+вино|молдавск\w*\s+(?:красн|бел|розов|игристое|сух|сладк|мягк)|рекомендуешь|посоветуете)/iu;
// Fuzzy discovery ask ("Что необычное/что-нибудь интересное можно попробовать
// из молдавского?") carries no chicken-color or sweet/dry descriptor, but the
// intent IS a recommendation. Gated on a try/taste verb + wine context so a
// factual "Расскажи что-нибудь интересное о виноделии" stays non-inference.
const DISCOVERY_RECOMMEND_RE = /(?:необычн[а-яё]*|интересн[а-яё]*|что-нибудь|что-то\s+(?:новое|необычн[а-яё]*|интересн[а-яё]*))\s+(?:можно\s+)?(?:попробовать|взять|выпить|заказать|открыть)/iu;
const WINE_ENTITY_RE = /(вин(?:о|а|е|ы|у)[а-яё]*|винн[а-яё]*|виноград[а-яё]*|wine|wines|winery|wineries)/iu;
// A wine descriptor (colour, sweetness, body, Moldovan origin) in the same
// turn as an intent verb is a recommendation ask even without the literal
// word "вино" -- e.g. "Хочу мягкое красное", "Посоветуй молдавское сухое".
const WINE_DESCRIPTOR_RE = /(красн[а-яё]*|бел[а-яё]*|розов[а-яё]*|игрист[а-яё]*|спаркл[а-яё]*|сух[а-яё]*|сладк[а-яё]*|полусладк[а-яё]*|полу-сладк|полусух[а-яё]*|полу-сух|мягк[а-яё]*|молдавск[а-яё]*|moldov\w*)/iu;
const INTENT_VERB_RE = /(хочу|посоветуй|посовету|подбери|подскаж|подсказ|рекоменд|какое|что\s+взять|что\s+попробовать|выбрать|подобрать|помоги)/iu;
// A factual ask for a specific wine attribute (price, strength, volume,
// vintage, grapes, producer) is never a Phase 6 intent, even when the turn
// also carries recommendation vocabulary ("Подскажи цену на Cricova",
// "Посоветуй, сколько стоит вино Negru de Purcari?"). A budget constraint
// ("до 300 леев", "по 300", "в пределах 300") turns a generic-wine turn into
// a recommendation ask ("цену на красное вино до 300 леев"), so the factual
// gate is skipped when a budget token is present AND no named wine entity is
// named. When a named wine is present ("цена на Cricova 1952 до 300 леев")
// the ask stays factual regardless of the budget token. All suffix wildcards
// are `[а-яё]*` -- ASCII `\w*` never matches Cyrillic inflections
// ("алкоголя", "градусов", "стоимостью").
// A price-budget token: "до 300 леев", "по 300", "в пределах 300", "около
// 200". The same token is used for both scenario detection and budget
// extraction so they can never diverge. A number followed by a non-price unit
// ("до 13 градусов", "до 12%", "до 750 мл", "до 1952 года") is NOT a budget:
// the lookahead rejects strength/volume/vintage/weight units before the
// number is treated as an MDL price. A qualifier-before-number ("крепостью до
// 13", "объёмом до 750") is also NOT a budget: BUDGET_QUALIFIER_RE vetoes the
// whole match. `(?!\d)` stops partial-digit matches ("до 1952 года" must not
// yield 195).
const BUDGET_AMOUNT_RE = /(?:до|не\s+дороже|в\s+пределах|в\s+районе|примерно|около|под|по)\s*(\d{2,5})(?!\d)(?!\s*(?:градус\w*|процент\w*|%|миллилитр\w*|мл(?!\p{L})|грамм\w*|г(?!\p{L})|литр\w*|л(?!\p{L})|год\w*|бутыл\w*))/iu;
const BUDGET_QUALIFIER_RE = /(?:крепост[а-яё]*|объ[её]м[а-яё]*|сахар[а-яё]*|остаточн[а-яё]*|выдерж[а-яё]*|розлив[а-яё]*|сладост[а-яё]*|танин[а-яё]*|кислотност[а-яё]*)\s+(?:(?:до|не\s+дороже|в\s+пределах|в\s+районе|примерно|около|под|по)\s*)?\d/iu;
// An explicit price cap with a currency unit ("до 300 леев", "по 500 lei").
// A qualifier veto (BUDGET_QUALIFIER_RE) must not drop a genuine price cap
// that co-occurs with an attribute qualifier in the same turn ("вино с
// выдержкой 5 лет до 300 леев"): the explicit price wins.
const PRICE_AMOUNT_RE = /(?:до|не\s+дороже|в\s+пределах|в\s+районе|примерно|около|под|по)\s*(\d{2,5})(?!\d)\s*(?:молдавских\s+)?(?:леев|лей|мдл|mdl|lei)(?!\p{L})/iu;
// Interrogative/ask markers that make an attribute word a factual question
// ("какая крепость", "сколько градусов", "узнать цену", "подскажи крепость").
// A recommendation ask carries only a preference verb ("Хочу красное вино
// крепостью до 13") and no question marker, so the factual gate stays off.
const QUESTION_MARKER_RE = /(?:какая|каков\w*|каковой|какие|какую|какой|сколько|во\s+сколько|поч[её]м|узна[а-яё]*|подскаж|показ\w*|посовету[а-яё]*|рекоменд[а-яё]*|порекоменд[а-яё]*|подбер[а-яё]*|что\s+за|в\s+каком\s+году|какого\s+года|кто\s+(?:производит|делает))/iu;
const FACTUAL_ATTRIBUTE_ASK_RE = /(?:во\s+сколько|сколько\s+стоит|сколько\s+стоят|сколько\s+будет\s+стоить|сколько\s+градусов|сколько\s+алкогол[а-яё]*|какая\s+цен[ауы]?|какова\s+цен[ауы]?|какую\s+цену|узнать\s+цен[ауы]?|цен[ауы]?\s+|цена\s+вина|стоимост[а-яё]*\s+(?:вина|этого|этой|на|стоит)|поч[её]м|крепост[а-яё]*\s+|градус[а-яё]*\s+(?:в|у|вина|алкоголя)|сколько\s+градусов|какой\s+градус|об[ъь][её]м[а-яё]*\s+(?:вина|бутылки|у)|год\s+выпуска|в\s+каком\s+году|какого\s+года|винтаж(?!н)[а-яё]*|сорта\s+винограда|какие\s+сорта|из\s+какого\s+винограда|кто\s+(?:производит|делает)\s+вин|производител[а-яё]*\s+(?:вина|этого|этой|эту|на)|алкогол[а-яё]*\s+(?:в|у)|сахар(?!н)[а-яё]*\s+|сладост(?!н)[а-яё]*\s+|танин(?!н)[а-яё]*\s+|кислотност[а-яё]*\s+|выдержк[а-яё]*\s+|розлив(?!н)[а-яё]*\s+)/iu;

// Multi-word proper nouns that resolve to wineries/products (from the shared
// registry) count as wine-related even without the word "wine" itself.
function _mentionsRegistryEntity(query) {
    try {
        return findMentionedEntities(String(query || '')).length > 0;
    } catch {
        return false;
    }
}

// Two distinct registry entities named in one turn ("Cricova или Purcari")
// are a comparison/choice ask even without a comparison verb.
function _mentionsTwoWineEntities(query) {
    try {
        const mentions = findMentionedEntities(String(query || ''));
        return new Set(mentions.map((m) => m.entityId)).size >= 2;
    } catch {
        return false;
    }
}

// The wine-related gate: an explicit wine word, a registry entity, or a wine
// descriptor used together with an intent verb. Keeps factual turns ("Сколько
// стоит вино Cricova 1952", "Расскажи о виноделии") from triggering. A fuzzy
// discovery ask ("Что необычное можно попробовать из молдавского?") already
// carries the try/taste verb in DISCOVERY_RECOMMEND_RE, so a wine word or
// wine descriptor anywhere in the turn is sufficient context for it.
function _hasWineContext(text) {
    if (WINE_ENTITY_RE.test(text)) return true;
    if (_mentionsRegistryEntity(text)) return true;
    if (DISCOVERY_RECOMMEND_RE.test(text) && WINE_DESCRIPTOR_RE.test(text)) return true;
    return WINE_DESCRIPTOR_RE.test(text) && INTENT_VERB_RE.test(text);
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
    const isBudgeted = PRICE_AMOUNT_RE.test(text) || (BUDGET_AMOUNT_RE.test(text) && !BUDGET_QUALIFIER_RE.test(text));
    const isNamedWine = _mentionsRegistryEntity(text);
    const isQuestion = QUESTION_MARKER_RE.test(text);
    // A factual/education attribute ask is never a Phase 6 intent. A budget
    // token only rescues the generic-wine recommendation form ("... красное
    // вино до 300 леев"): when a named wine is present ("цена на Cricova 1952
    // до 300 леев") the ask stays factual regardless of the budget token, and
    // a bare attribute word without a question marker ("Хочу красное вино
    // крепостью до 13") is a preference, not a factual ask. A qualifier
    // construction ("вино крепостью до 13") is also a preference even when a
    // recommendation verb ("Подбери", "Рекомендуй") doubles as a question
    // marker.
    if (FACTUAL_ATTRIBUTE_ASK_RE.test(text) && _hasWineContext(text) && !(isBudgeted && !isNamedWine) && (isQuestion || isNamedWine) && !BUDGET_QUALIFIER_RE.test(text)) return null;
    if (FOOD_PAIRING_RE.test(text) && _hasDishSignal(text)) return SCENARIOS.PAIR_FOOD;
    // A comparison ask must name at least one concrete wine/winery from the
    // registry ("Сравни Cricova" -> compare handler honestly asks for the
    // second wine). Education turns that only compare generic wine categories
    // ("Чем отличается красное вино от белого?") carry no registry entity,
    // so they stay general-knowledge instead of hijacking the comparison path.
    if (COMPARISON_RE.test(text) && _mentionsRegistryEntity(text)) return SCENARIOS.COMPARE_WINES;
    if (_mentionsTwoWineEntities(text) && /(?:^|[^\p{L}\p{N}])(?:или|or|либо)(?:[^\p{L}\p{N}]|$)/iu.test(text)) return SCENARIOS.COMPARE_WINES;
    if (ROUTE_RE.test(text) && _hasWineContext(text)) return SCENARIOS.PLAN_ROUTE;
    if (RECOMMEND_RE.test(text) && _hasWineContext(text)) return SCENARIOS.RECOMMEND_WINE;
    if (DISCOVERY_RECOMMEND_RE.test(text) && _hasWineContext(text)) return SCENARIOS.RECOMMEND_WINE;
    if (INTENT_VERB_RE.test(text) && _hasWineContext(text)) return SCENARIOS.RECOMMEND_WINE;
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

    if (/\bлегк\w*/iu.test(text) || /мягк\w*/iu.test(text) || /\blight\b/iu.test(text)) prefs.body = 'light';
    else if (/полнотел|полн\w*\s+тел\w*/iu.test(text) || /\bfull[- ]?bodied\b/iu.test(text)) prefs.body = 'full';
    else if (/средн\w*\s+тел|medium/iu.test(text)) prefs.body = 'medium';

    if (/(праздник|свидан\w*|юбил|свадьб|ужин|вечеринк|подарок|в\s*подарок|occasion|celebration|dinner)/iu.test(text)) {
        prefs.occasion = 'celebration';
    }

    // An explicit price cap ("до 300 леев") wins over a qualifier veto, so a
    // turn carrying both an attribute qualifier and a real budget keeps the
    // budget ("вино с выдержкой 5 лет до 300 леев").
    const budgetMatch = PRICE_AMOUNT_RE.test(text)
        ? text.match(PRICE_AMOUNT_RE)
        : (!BUDGET_QUALIFIER_RE.test(text) ? text.match(BUDGET_AMOUNT_RE) : null);
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
async function gatherEvidence(query, { language = null, allowWeb = false, allowCatalog = true, limit = 8, adapters = {} } = {}) {
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
        allowCatalog ? run('searchCatalog', adapters.searchCatalog || layeredRouter.searchCatalog) : Promise.resolve([]),
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

// Distinguishes a real bottled wine in the catalog from an editorial article /
// guide that the Wine.md feed occasionally emits as a catalog row (e.g. "Чем
// пахнут разные сорта белого вина: сохраните себе эту удобную шпаргалку!").
// A row is treated as a bottle only when it carries at least one concrete wine
// signal: a resolved winery/brand entity, a vintage, a price, or a product URL
// that classifiers as a wine product page. Anything else is never recommended
// as a wine (INVARIANTS: no fabricated wines / no general text as a bottle).
function isWineCatalogItem(item) {
    if (item.level !== 'catalog' || !item.catalog) return false;
    const c = item.catalog;
    if (c.wine_entity_id) return true;
    if (c.vintage != null && String(c.vintage).trim()) return true;
    if (typeof c.price === 'number' && Number.isFinite(c.price) && c.price > 0) return true;
    const url = String(c.product_url || c.external_id || item.source || '').trim();
    if (!url) return false;
    try {
        return classifyWineMdUrl(url).type === 'wine_product';
    } catch {
        return false;
    }
}

function wineNamesFromEvidence(evidence) {
    const names = new Map();
    for (const item of evidence) {
        if (item.structured_kind === 'entity_relation' && item.relation?.predicate === 'produces') {
            const name = String(item.relation.object_value || '').trim();
            if (name) names.set(normalize(name), name);
        }
        if (isWineCatalogItem(item) && item.title) {
            names.set(normalize(item.title), item.title);
        }
    }
    return [...names.values()];
}

function relationItems(evidence, predicate = null) {
    return (evidence || []).filter((item) =>
        item.structured_kind === 'entity_relation' && (!predicate || item.relation?.predicate === predicate));
}

// A style is only ever resolved from a REAL profile: a catalog row carrying a
// profile, an official bottle profile, or an exact style/grape name. The
// colour-substring fallback ("red" appearing anywhere in a wine name) is
// deliberately not used here: it would invent a style for a wine with no
// supported data (INVARIANTS: no fabricated facts).
function groundedWineStyle(name, evidence) {
    const norm = normalize(name);
    if (!norm) return null;
    const profiles = [...catalogProfilesFromEvidence(evidence), ...OFFICIAL_BOTTLE_PROFILES];
    const profile = profiles.find((p) => (p.aliases || [p.name]).some((alias) => norm.includes(normalize(alias))));
    if (profile) return profile;
    return WINE_STYLES.find((s) => norm === normalize(s.name) || s.grapes.some((g) => norm === normalize(g))) || null;
}

// Resolve one wine name against evidence to its best style + bottle facts.
function wineFacts(name, evidence) {
    const norm = normalize(name);
    const style = groundedWineStyle(name, evidence);
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
    return catalogItems(evidence)
        .filter(isWineCatalogItem)
        .map((item) => ({
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
    reasons.push(`К блюду ${dish.food ? `«${labelFood(dish.food)}»` : ''} по насыщенности, жирности, кислотности и остроте подойдут такие стили:`.replace('  ', ' '));
    candidates.forEach((candidate) => {
        reasons.push(`${candidate.style_name}: ${(candidate.reasons || []).map(labelReason).join(', ') || 'похожая интенсивность'}${candidate.bottles.length ? `. Например: ${candidate.bottles.join(', ')}` : ''}.`);
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
        if (style.color === prefs.color) { score += 20; matches.push(`цвет: ${labelColor(style.color)}`); }
        // Hard color gate: when the user explicitly asks for a colour, a
        // conflicting-colour wine is never recommended, no matter how well it
        // matches sweetness/body/budget (INVARIANTS: hard preference).
        else return { score: 0, matches: [] };
    }
    if (prefs.sweetness && style) {
        const sweet = style.sweetness >= 3 ? 'sweet' : style.sweetness === 2 ? 'semi_dry' : 'dry';
        if (sweet === prefs.sweetness) { score += 12; matches.push(`сладость: ${labelSweetness(sweet)}`); }
    }
    if (prefs.body && style) {
        const body = style.body >= 3 ? 'full' : style.body === 2 ? 'medium' : 'light';
        if (body === prefs.body) { score += 10; matches.push(`тело: ${labelBody(body)}`); }
    }
    if (prefs.food && style) {
        if ((style.foods || []).includes(prefs.food)) { score += 15; matches.push(`подходит к ${labelFood(prefs.food)}`); }
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
        missing.push(`Пока не удалось подобрать вина под ${Object.keys(prefs).length ? 'указанные предпочтения' : 'запрос'}. Уточните цвет, сухость, блюдо, регион или бюджет — и я подберу точнее.`);
    }
    if (missing.length) {
        return { found: false, confidence: 'low', explanation: missing, missing };
    }

    const ranked = candidates.sort((a, b) => b.score - a.score).slice(0, 3);
    const reasons = ranked.map((candidate) =>
        `${candidate.name} (${candidate.style})${candidate.producer ? `, производитель ${candidate.producer}` : ''}` +
        `${candidate.price != null ? `, ${candidate.price} MDL` : ''} — ${candidate.matches.join(', ')}.`);
    reasons.push(`Подбор учёл ваши предпочтения: ${describePreferences(prefs)}.`);
    // Budget honesty: if the user gave a budget but no candidate carried a
    // confirmed in-budget price, say so instead of implying the ask was met.
    if (prefs.budget && !ranked.some((c) => c.price != null && c.price <= prefs.budget)) {
        reasons.push('Точные цены в каталоге пока не подтверждены — сумму лучше уточнить перед покупкой.');
    }
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

    // Data sufficiency honesty (INVARIANTS: never invent facts, never claim a
    // comparison exists when the knowledge base carries nothing about either
    // candidate). A comparison is only "found" when BOTH sides have at least
    // one concrete wine attribute each -- style, grapes, region, or price. A
    // bare producer relation ("winery-a produces X") is not enough on its own
    // to compare the wines, so it never counts as a supported fact here;
    // otherwise we say exactly which side is missing data instead of building
    // a fake table.
    const hasFacts = (facts) => Boolean(
        facts.style || facts.grapes.length || facts.region.length || facts.price != null,
    );
    const aKnown = hasFacts(a);
    const bKnown = hasFacts(b);
    if (!aKnown && !bKnown) {
        return {
            found: false,
            confidence: 'low',
            explanation: [`По винам/винодельням «${aName}» и «${bName}» пока нет подтверждённых данных для сравнения.`],
            missing: [`Пока нет подтверждённых сведений ни об одном из кандидатов («${aName}», «${bName}») — нужно больше данных в каталоге.`],
        };
    }
    if (!aKnown || !bKnown) {
        const unknownSide = aKnown ? bName : aName;
        return {
            found: false,
            confidence: 'low',
            explanation: [`По «${unknownSide}» пока нет подтверждённых данных, поэтому сравнение с «${aKnown ? aName : bName}» построить нельзя.`],
            missing: [`Не хватает данных о «${unknownSide}» — уточните вопросы по этой винодельне/вину, и я смогу сравнить её с «${aKnown ? aName : bName}».`],
        };
    }

    const explanation = [`Сравнение ${aName} и ${bName}.`];
    if (differences.length) explanation.push(`Ключевые отличия: ${differences.join(', ')}.`);
    // Similarity is only claimed when real values exist on BOTH sides for at
    // least one attribute -- never when every attribute is unknown.
    else if (rows.some((row) => row.a !== '—' && row.b !== '—')) {
        explanation.push('По имеющимся данным вина схожи по всем доступным атрибутам.');
    }
    if (!a.style || !b.style) {
        explanation.push('По одному из вин данных меньше — сравнение строится по тому, что известно.');
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
    // "по Молдове / Moldova" is country-level, not a sub-region filter: the
    // user means anywhere in Moldova, so the region constraint is dropped and
    // all wineries with route evidence qualify.
    if (constraints.region && /(^|\s)молдов|moldova/iu.test(String(constraints.region))) {
        delete constraints.region;
    }
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
            ? [`По региону «${constraints.region}» пока не удалось найти винодельни с экскурсиями или дегустациями. Уточните регион или уберите ограничение.`]
            : ['Пока не удалось найти винодельни с экскурсиями или дегустациями. Уточните регион.'];
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
        `Составлен маршрут по ${stops.length} винодельням${constraints.region ? ` в регионе ${constraints.region}` : ''}:`,
        ...stops.map((stop) => `${stop.name} — ${stop.tour ? 'экскурсия' : ''}${stop.tour && stop.tasting ? ' и ' : ''}${stop.tasting ? 'дегустация' : ''}${stop.tour || stop.tasting ? '' : ' (без подтверждённых туров)'}.`),
    ];
    if (constraints.hours) explanation.push(`Ограничение по времени: ${constraints.hours} ч — распределите визиты соответственно.`);
    if (constraints.budget) explanation.push(`Бюджет: до ${constraints.budget} MDL на визит — точную стоимость уточняйте у каждой винодельни.`);

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
        allowCatalog: options.allowCatalog !== false,
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

// Intent-driven entry shared by the live tool and the audit orchestrator, so
// the benchmark measures the same production behavior. Runs inference only
// when detectScenario() finds a Phase 6 intent (pairing, recommendation,
// comparison, route) -- factual turns never trigger it. `suppress` (the
// explicit no_inference audit constraint) disables it entirely. A failing or
// empty inference returns null and never affects the retrieval outcome.
async function inferForQuestion(question, options = {}) {
    if (options.suppress === true) return null;
    const scenario = detectScenario(String(question || ''));
    if (!scenario) return null;
    try {
        const run = await runInference(question, {
            language: options.language,
            allowWeb: options.allowWeb === true,
            allowCatalog: options.allowCatalog !== false,
            limit: options.limit || 8,
            adapters: options.adapters || {},
        });
        if (!run || !run.scenario) return null;
        return {
            scenario: run.scenario,
            found: run.found === true,
            confidence: run.confidence || null,
            explanation: run.explanation || [],
            missing: run.missing || [],
            inference: run.inference || null,
            claims: run.claims || [],
        };
    } catch (error) {
        return null;
    }
}

module.exports = {
    SCENARIOS,
    SCENARIO_LIST,
    detectScenario,
    parseRecommendationPreferences,
    gatherEvidence,
    runInference,
    inferForQuestion,
    pairFood,
    recommendWine,
    compareWines,
    planRoute,
    buildInferenceClaims,
    WINE_STYLES,
};
