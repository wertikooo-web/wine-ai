'use strict';

// Intent + Subject classifier for fast routing.
//
// Given a user query, determines:
// 1. What entity type is being asked about (subject)
// 2. What the user wants to know (intent)
// 3. Which source/tool should handle the query (route)
//
// This runs BEFORE any retrieval — it's a cheap string-based classifier
// that avoids launching embeddings, multi-step semantic search, or LLM calls
// for simple scalar fact queries.

const SUBJECT_PATTERNS = [
    { subject: 'winery', patterns: [/винодельн/i, /winery/i, /винарн/i, /odegaard/i, /crame/i, /chateau/i, / cellars?\b/i] },
    { subject: 'wine', patterns: [/вино[мк]?\b/i, /wine\b/i, /vin[ău]?\b/i, /бутылк/i, /bottle/i, /классифик/i, /classification/i] },
    { subject: 'grape', patterns: [/сорт[а-я]* виноград/i, /grape varieties?/i, /feteasca/i, /rară/i, /sauvignon/i, /merlot/i, /cabernet/i] },
    { subject: 'region', patterns: [/регион/i, /region/i, /зона/i, /zone/i, /кодру/i, /стэфанешти/i, /valle[iy]/i, /тигу/i] },
    { subject: 'tourism', patterns: [/тур/i, /tour/i, /экскурс/i, /excurs/i, /дегустац/i, /tasting/i, /маршрут/i, /route/i, /как добраться/i, /how to get/i, /map/i, /карт[аы]/i] },
    { subject: 'commerce', patterns: [/купить/i, /buy/i, /price/i, /цен[ауие]/i, /стоимост/i, /cost/i, /наличи/i, /available/i, /where to buy/i, /где куп/i, /магазин/i, /shop/i] },
    { subject: 'event', patterns: [/событ/i, /event/i, /мероприят/i, /фестивал/i, /festival/i, /день вин/i, /news/i, /новост/i] },
    { subject: 'platform', patterns: [/wine\.?md/i, /wine-md/i, /винемд/i, /вин\.?мд/i] },
];

const INTENT_PATTERNS = [
    { intent: 'locate', patterns: [/адрес/i, /address/i, /где находит/i, /where is/i, /where located/i, /str\.\s/i, /ул\./i, /улиц/i, /добрать/i, /how to get/i, /как добр/i, /map/i, /карт[ауие]/i, /координат/i, /coordinates?/i, /latitude/i, /longitude/i] },
    { intent: 'contact', patterns: [/телефон/i, /phone/i, /contact/i, /связ/i, /email/i, /почта/i, /mail/i] },
    { intent: 'hours', patterns: [/час[ыов]* работы/i, /opening hours/i, /когда работ/i, /when.*open/i, /schedule/i, /сегодня работ/i, /today.*open/i, /working hours/i, /time/i] },
    { intent: 'website', patterns: [/сайт/i, /website/i, /official/i, /официал/i, /страниц/i, /page/i, /url/i, /link/i, /ссылк/i] },
    { intent: 'booking', patterns: [/бронир/i, /booking/i, /резерв/i, /reservation/i, /записаться/i] },
    { intent: 'purchase', patterns: [/купить/i, /buy/i, /где куп/i, /where to buy/i, /заказать/i, /order/i, /приобрест/i] },
    { intent: 'price', patterns: [/цен[ауие]/i, /price/i, /стоимост/i, /cost/i, /сколько/i, /how much/i] },
    { intent: 'availability', patterns: [/наличи/i, /available/i, /есть ли/i, /in stock/i] },
    { intent: 'describe', patterns: [/расскаж/i, /tell.*about/i, /что这样的/i, /что такое/i, /describe/i, /overview/i, /описан/i, /что извест/i, /what.*know/i, /what is/i, /истор/i, /history/i] },
    { intent: 'tasting_notes', patterns: [/вкус/i, /taste/i, /аромат/i, /aroma/i, /bouquet/i, /дегуст/i, /tasting/i, /note/i, /notebook/i] },
    { intent: 'pairing', patterns: [/сочетан/i, /pairing/i, /food/i, /еда/i, /блюдо/i, /dish/i, /recommend.*with/i, /рекоменд.*к/i] },
    { intent: 'composition', patterns: [/состав/i, /composition/i, /грозд/i, /grape/i, /alcohol/i, /сахар/i, /sugar/i, /кислот/i, /acidity/i, /выдерж/i, /aging/i, /баррик/i, /barrel/i] },
    { intent: 'awards', patterns: [/наград/i, /award/i, /медал/i, /medal/i, /конкурс/i, /competition/i] },
    { intent: 'compare', patterns: [/сравни/i, /compare/i, /versus/i, /vs\.?\s/i, /одинаков/i] },
    { intent: 'latest_news', patterns: [/последн/i, /latest/i, /новейш/i, /newest/i, /recent/i, /news/i, /сейчас/i, /now/i] },
];

const INTENT_TO_ROUTE = {
    locate: 'structured_facts',
    contact: 'structured_facts',
    hours: 'structured_facts',
    website: 'structured_facts',
    booking: 'structured_facts',
    purchase: 'commerce',
    price: 'commerce',
    availability: 'commerce',
    describe: 'kos_retrieval',
    tasting_notes: 'kos_retrieval',
    pairing: 'kos_retrieval',
    composition: 'kos_retrieval',
    awards: 'kos_retrieval',
    compare: 'kos_retrieval',
    latest_news: 'external_search',
};

const SUBJECT_TO_ROUTE_DEFAULT = {
    winery: 'kos_retrieval',
    wine: 'kos_retrieval',
    grape: 'kos_retrieval',
    region: 'kos_retrieval',
    tourism: 'external_search',
    commerce: 'commerce',
    event: 'external_search',
    platform: 'structured_facts',
};

/**
 * Classify a user query into subject + intent + route.
 * Returns { subject, intent, route, confidence }.
 */
function classifyQuery(query, { activeEntity = null, activeEntityType = null } = {}) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { subject: 'general', intent: 'describe', route: 'kos_retrieval', confidence: 0 };

    let bestSubject = null;
    let bestSubjectScore = 0;

    for (const { subject, patterns } of SUBJECT_PATTERNS) {
        let score = 0;
        for (const p of patterns) {
            if (p.test(q)) score++;
        }
        if (score > bestSubjectScore) {
            bestSubjectScore = score;
            bestSubject = subject;
        }
    }

    // Use active entity type as fallback for subject
    if (!bestSubject && activeEntityType) {
        bestSubject = activeEntityType === 'platform' ? 'platform' : activeEntityType;
    }
    if (!bestSubject) bestSubject = 'general';

    let bestIntent = null;
    let bestIntentScore = 0;

    for (const { intent, patterns } of INTENT_PATTERNS) {
        let score = 0;
        for (const p of patterns) {
            if (p.test(q)) score++;
        }
        if (score > bestIntentScore) {
            bestIntentScore = score;
            bestIntent = intent;
        }
    }

    // Follow-up heuristic: if query is very short and we have an active entity,
    // it's likely a follow-up about that entity
    if (!bestIntent && activeEntity && q.length < 50) {
        bestIntent = 'describe'; // default to description for ambiguous follow-ups
    }
    if (!bestIntent) bestIntent = 'describe';

    // Determine route from intent, falling back to subject default
    const route = INTENT_TO_ROUTE[bestIntent] || SUBJECT_TO_ROUTE_DEFAULT[bestSubject] || 'kos_retrieval';

    const confidence = Math.min(
        (bestSubjectScore > 0 ? 0.5 : 0) + (bestIntentScore > 0 ? 0.5 : 0),
        1.0
    );

    return { subject: bestSubject, intent: bestIntent, route, confidence };
}

/**
 * Check if a query needs external search (no internal data available).
 */
function needsExternalSearch(classification) {
    return classification.route === 'external_search' || classification.route === 'commerce';
}

/**
 * Get the recommended fact types to fetch for a given intent.
 */
function requiredFactTypes(intent) {
    const map = {
        locate: ['address', 'city', 'country', 'latitude', 'longitude'],
        contact: ['phone', 'email'],
        hours: ['opening_hours'],
        website: ['official_website', 'booking_url', 'purchase_url'],
        booking: ['booking_url'],
        purchase: ['purchase_url'],
        price: ['price', 'availability'],
        describe: ['short_description', 'description'],
        composition: ['grapes', 'alcohol', 'vintage'],
        tasting_notes: ['tasting_notes', 'serving_temperature'],
        pairing: ['pairing'],
        awards: ['awards'],
    };
    return map[intent] || ['short_description'];
}

module.exports = {
    classifyQuery,
    needsExternalSearch,
    requiredFactTypes,
    INTENT_TO_ROUTE,
    SUBJECT_TO_ROUTE_DEFAULT,
};
