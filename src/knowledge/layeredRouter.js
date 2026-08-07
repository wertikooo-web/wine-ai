'use strict';

const db = require('./db');
const { search } = require('./search');
const { searchWeb } = require('./webSearch');
const catalogStore = require('../catalog/wineMdCatalogStore');
const liveWineMdTool = require('../tools/checkWineMdAvailability');

const LEVELS = Object.freeze({
    CANONICAL: 'canonical',
    CATALOG: 'catalog',
    DOCUMENTS: 'documents',
    WEB: 'web',
});

const LEVEL_RANK = Object.freeze({ canonical: 0, catalog: 1, documents: 2, web: 3 });
const WEB_SOURCE_PRIORITY = Object.freeze({
    official_winery: 0,
    government: 1,
    onvv: 1,
    partner_catalog: 2,
    official_event: 3,
    specialist_media: 4,
    general_web: 5,
});

function normalize(value) {
    return String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function queryTokens(query) {
    return normalize(query)
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .split(/\s+/)
        .filter((token) => token.length >= 2)
        .slice(0, 10);
}

// JavaScript's \b is ASCII-oriented and does not create reliable word
// boundaries around Cyrillic/Romanian letters. These patterns deliberately
// match stems inside normalized Unicode text instead.
function isFreshnessQuery(query) {
    return /(сейчас|сегодня|актуальн|цена|стоим|стоит|налич|купить|где купить|расписан|открыт|час|новост|событ|event|today|current|price|stock|availability|opening|schedule|acum|astăzi|preț|stoc|program|eveniment)/iu.test(normalize(query));
}

function isCatalogQuery(query) {
    return /(цена|стоим|стоит|налич|купить|где купить|заказать|фото|бутылк|price|stock|availability|buy|order|image|preț|stoc|cumpăr|comand)/iu.test(normalize(query));
}

// Our own partner wineries/brands -- kept in sync with safeFetch.js's
// ALLOWED_DOMAINS entries by name (not domain). Used as the default
// knownEntityNames for classifyQueryIntent() so a bare mention of "Cricova"
// or "Purcari" routes internal-first even without an explicit caller-
// supplied entity list.
const KNOWN_WINERY_NAMES = Object.freeze([
    'Purcari', 'Cricova', 'Castel Mimi', 'Vartely', 'Asconi', 'Et Cetera', 'Etcetera',
    'Gitana', 'Fautor', 'Salcuta', 'Basavin', 'Kvint', 'Vinuri de Comrat', 'Carlevana',
]);

// Recognizes our own partners/products by name -- questions about them stay
// internal-database-first. This is intentionally a simple substring match
// against known entity names, not a full NLU pass; false negatives just
// fall through to the general_wine/off_topic tiers, which still check
// internal evidence first anyway (routeKnowledge always runs canonical/
// catalog/documents regardless of intent).
function _mentionsKnownEntity(query, knownEntityNames = KNOWN_WINERY_NAMES) {
    const norm = normalize(query);
    return knownEntityNames.some((name) => name && norm.includes(normalize(name)));
}

function _isWineRelated(query) {
    return /(вин[оаеуы]|виноград|сомелье|дегустац|винодел|терруар|сорт[а-я]*\s*винограда|wine|grape|sommelier|tasting|winery|terroir|vin\b|vinifica)/iu.test(normalize(query));
}

// Off-topic questions still worth a web search: they ask for a fact,
// recommendation, or something current -- as opposed to small talk, which
// never needs (or benefits from) a web call.
function _isFactualQuestion(query) {
    return /(кто|что|где|когда|почему|зачем|как|сколько|какой|какая|какое|какие|who|what|where|when|why|how|which|погода|курс|новост|событ)/iu.test(normalize(query));
}

// Three-tier product routing decision (see docs/architecture --
// "WineAI web search routing"):
// - 'own_entity': about our own wines/wineries/catalog/Knowledge Studio
//   material -- internal database and official sources first; web only for
//   freshness (price/stock/hours/events), same as before this feature.
// - 'general_wine': wine knowledge with no tie to our own partners --
//   grapes, regions, history, styles, pairings, ratings, travel, culture --
//   web runs proactively alongside the internal search, not only as a
//   last-resort fallback.
// - 'off_topic_factual': not about wine, but asks for a fact/recommendation/
//   current information -- web is allowed.
// - 'off_topic_smalltalk': ordinary conversation with no factual content --
//   web is never used; there is nothing to look up.
function classifyQueryIntent(query, { knownEntityNames = KNOWN_WINERY_NAMES } = {}) {
    if (isCatalogQuery(query) || _mentionsKnownEntity(query, knownEntityNames)) return 'own_entity';
    if (_isWineRelated(query)) return 'general_wine';
    return _isFactualQuestion(query) ? 'off_topic_factual' : 'off_topic_smalltalk';
}

function confidenceRank(value) {
    return ({ verified: 0, high: 1, medium: 2, low: 3, unverified: 4 })[value] ?? 3;
}

function buildTokenWhere(tokens, columns, firstParam = 1) {
    const clauses = [];
    const params = [];
    tokens.forEach((token, tokenIndex) => {
        const paramIndex = firstParam + tokenIndex;
        clauses.push(`(${columns.map((column) => `${column} LIKE $${paramIndex}`).join(' OR ')})`);
        params.push(`%${token}%`);
    });
    return { sql: clauses.length ? clauses.join(' AND ') : 'FALSE', params };
}

async function searchCanonical(query, { limit = 8, pool = db.getPool() } = {}) {
    if (!pool) return [];
    const tokens = queryTokens(query);
    if (!tokens.length) return [];
    const where = buildTokenWhere(tokens, [
        'lower(entity_id)',
        "lower(COALESCE(field_name,''))",
        "lower(COALESCE(normalized_value,''))",
        "lower(COALESCE(raw_value,''))",
        "lower(COALESCE(evidence,''))",
    ]);
    const { rows } = await pool.query(`
        SELECT id, entity_id, entity_type, field_name, normalized_value, raw_value,
               confidence, validation_status, source_url, source_type, source_domain,
               evidence, verified_at, expires_at
        FROM entity_facts
        WHERE active = TRUE
          AND validation_status IN ('approved','validated')
          AND (expires_at IS NULL OR expires_at > NOW())
          AND ${where.sql}
        ORDER BY
          CASE validation_status WHEN 'approved' THEN 0 ELSE 1 END,
          CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
          COALESCE(verified_at, NOW()) DESC
        LIMIT $${where.params.length + 1}
    `, [...where.params, limit]);
    return rows.map((row) => ({
        level: LEVELS.CANONICAL,
        text: `${row.field_name}: ${row.raw_value || row.normalized_value}`,
        title: row.entity_id,
        source: row.source_url || row.source_domain || 'entity_facts',
        source_type: row.source_type || 'canonical',
        confidence: row.validation_status === 'approved' && row.confidence === 'high' ? 'verified' : row.confidence,
        provenance: {
            fact_id: row.id,
            entity_id: row.entity_id,
            validation_status: row.validation_status,
            verified_at: row.verified_at,
            expires_at: row.expires_at,
        },
    }));
}

function catalogRowToEvidence(row, sourceType = 'partner_catalog') {
    return {
        level: LEVELS.CATALOG,
        text: row.title,
        title: row.title,
        source: row.product_url || 'https://wine.md/',
        source_type: sourceType,
        confidence: 'verified',
        catalog: {
            product_id: row.id || null,
            external_id: row.external_id || null,
            wine_entity_id: row.wine_entity_id || null,
            vintage: row.vintage || null,
            volume_ml: row.volume_ml || null,
            price: row.price == null ? null : Number(row.price),
            currency: row.currency || 'MDL',
            availability: row.availability || 'unknown',
            stock_quantity: row.stock_quantity == null ? null : Number(row.stock_quantity),
            product_url: row.product_url || row.url || null,
            image_url: row.image_url || null,
            last_synced_at: row.last_synced_at || null,
        },
    };
}

async function searchCatalog(query, options = {}) {
    const structured = await catalogStore.searchCatalog(query, options);
    if (structured.length) return structured.map((row) => catalogRowToEvidence(row));

    if (options.liveFallback === false) return [];
    const live = await liveWineMdTool.impl({ query });
    if (!live?.found) return [];
    return live.results.map((row, index) => catalogRowToEvidence({
        id: `live_${index}`,
        title: row.title,
        product_url: row.url,
        availability: 'listed',
        last_synced_at: new Date().toISOString(),
    }, 'partner_catalog_live'));
}

async function searchDocuments(query, { language = null, limit = 8, searchImpl = search } = {}) {
    const result = await searchImpl(query, { language, limit });
    return result.hits.map(({ chunk, score }) => ({
        level: LEVELS.DOCUMENTS,
        text: chunk.text,
        title: chunk.metadata.title,
        source: chunk.metadata.source || chunk.metadata.source_file,
        source_type: chunk.metadata.source_type || 'document',
        confidence: chunk.metadata.confidence || 'medium',
        relevance_score: score,
        provenance: {
            source_file: chunk.metadata.source_file,
            chunk_id: chunk.id,
            language: chunk.metadata.language,
        },
    }));
}

async function searchInternet(query, { language = null, limit = 5, webSearchImpl = searchWeb } = {}) {
    const result = await webSearchImpl(query, { language, maxResults: limit });
    if (!result.found) return [];
    return result.results.map((row) => ({
        level: LEVELS.WEB,
        text: row.snippet,
        title: row.title,
        source: row.url,
        source_type: row.source_type || 'general_web',
        confidence: row.confidence || 'medium',
        provenance: { url: row.url, provider: result.provider || null },
    })).sort((a, b) => {
        const pa = WEB_SOURCE_PRIORITY[a.source_type] ?? 9;
        const pb = WEB_SOURCE_PRIORITY[b.source_type] ?? 9;
        if (pa !== pb) return pa - pb;
        return confidenceRank(a.confidence) - confidenceRank(b.confidence);
    });
}

function naturalAnswerPolicy() {
    return {
        tone: 'confident_clear',
        disclose_internal_search_process: false,
        source_display: 'ui_or_citation_when_useful',
        rules: [
            'Answer the question immediately from the strongest available evidence.',
            'Do not say that the internal database lacked information.',
            'Do not announce that web search was used.',
            'Do not merge conflicting claims into one certain statement.',
            'For price, stock, hours, schedules, or events, say “сейчас” or the equivalent in the user language and include the source link in the UI result.',
            'When evidence is insufficient, say the specific fact cannot be reliably confirmed right now, without exposing internal routing.',
            'Never read a URL or link out loud -- sources are shown visually in the UI, never spoken.',
        ],
    };
}

// For own_entity/freshness/catalog queries, internal (canonical/catalog/
// documents) evidence must outrank web -- our own data wins. But for eager-
// web intents (general_wine, off_topic_factual) the web call exists BECAUSE
// the question is not really about our own entities; generic internal
// documents that merely share vocabulary with the question must not be
// allowed to crowd the actually-relevant web results out of the top-N slice
// downstream (evaluator/gate/tool all truncate evidence to a fixed limit).
// In that case, web ranks with documents instead of after them.
function sortEvidence(items, { webPriority = false } = {}) {
    // Tying web's rank with documents is not enough: Array#sort is stable,
    // and internal items are always concatenated before web ones by the
    // caller, so an equal rank still lets documents win every tie. Web must
    // rank strictly ahead of (generic) documents here, not level with them.
    const rank = webPriority ? { ...LEVEL_RANK, web: LEVEL_RANK.documents - 0.5 } : LEVEL_RANK;
    return items.sort((a, b) => {
        const lr = (rank[a.level] ?? 9) - (rank[b.level] ?? 9);
        if (lr !== 0) return lr;
        const cr = confidenceRank(a.confidence) - confidenceRank(b.confidence);
        if (cr !== 0) return cr;
        return (b.relevance_score || 0) - (a.relevance_score || 0);
    });
}

function detectConflicts(evidence) {
    const volatileFields = new Set(['price', 'availability', 'stock_quantity', 'opening_hours', 'schedule']);
    const byKey = new Map();
    for (const item of evidence) {
        if (item.level === LEVELS.CANONICAL && item.provenance?.entity_id) {
            const field = String(item.text || '').split(':')[0].trim();
            const key = `${item.provenance.entity_id}:${field}`;
            const value = String(item.text || '').slice(field.length + 1).trim();
            if (!byKey.has(key)) byKey.set(key, new Set());
            byKey.get(key).add(value);
        }
        if (item.level === LEVELS.CATALOG && item.catalog) {
            for (const field of volatileFields) {
                const value = item.catalog[field];
                if (value == null) continue;
                const key = `${item.catalog.external_id || item.title}:${field}`;
                if (!byKey.has(key)) byKey.set(key, new Set());
                byKey.get(key).add(String(value));
            }
        }
    }
    return [...byKey.entries()]
        .filter(([, values]) => values.size > 1)
        .map(([key, values]) => ({ key, values: [...values] }));
}

async function routeKnowledge(query, options = {}) {
    const language = options.language || null;
    const allowWeb = options.allowWeb !== false;
    const forceWeb = options.forceWeb === true;
    const freshness = isFreshnessQuery(query);
    const catalogIntent = isCatalogQuery(query);
    const intent = classifyQueryIntent(query, options.knownEntityNames ? { knownEntityNames: options.knownEntityNames } : {});
    // For general wine knowledge and factual off-topic questions, web runs
    // proactively -- it is not gated on internal evidence being weak. Own-
    // entity questions keep the original fallback-only behavior (freshness
    // or weak internal evidence), so facts about our own partners still
    // default to our own data. Smalltalk never triggers web -- there is
    // nothing to look up.
    const eagerWeb = intent === 'general_wine' || intent === 'off_topic_factual';
    const attempts = [];
    const adapters = options.adapters || {};

    const runLevel = async (level, runner) => {
        try {
            const items = await runner();
            attempts.push({ level, status: items.length ? 'found' : 'empty', count: items.length });
            return items;
        } catch (error) {
            attempts.push({ level, status: 'error', error: error.message });
            return [];
        }
    };

    const internalPromise = (async () => {
        const canonical = await runLevel(LEVELS.CANONICAL, () =>
            (adapters.searchCanonical || searchCanonical)(query, options));
        const catalog = (catalogIntent || freshness)
            ? await runLevel(LEVELS.CATALOG, () => (adapters.searchCatalog || searchCatalog)(query, options))
            : [];
        const documents = await runLevel(LEVELS.DOCUMENTS, () =>
            (adapters.searchDocuments || searchDocuments)(query, { ...options, language }));
        return { canonical, catalog, documents };
    })();

    // eagerWeb fires web concurrently with internal retrieval instead of
    // waiting to see whether internal evidence turns out weak -- for
    // general wine knowledge we want it every time regardless, so there is
    // no reason to pay the extra round-trip latency of running it after.
    const eagerWebPromise = (allowWeb && eagerWeb)
        ? runLevel(LEVELS.WEB, () => (adapters.searchInternet || searchInternet)(query, { ...options, language }))
        : null;

    const { canonical, catalog, documents } = await internalPromise;
    const internal = [...canonical, ...catalog, ...documents];
    const strongInternal = canonical.length > 0
        || catalog.length > 0
        || documents.some((item) => Number(item.relevance_score || 0) >= Number(options.documentThreshold || 0.45));

    // Smalltalk never triggers web, full stop -- not even the old "internal
    // evidence came back empty, try web as a last resort" fallback. There
    // is nothing to look up for "thanks, that was lovely"; retrieval coming
    // back empty for smalltalk is expected, not a reason to spend budget.
    const smalltalk = intent === 'off_topic_smalltalk';

    let web;
    let webReason;
    if (eagerWebPromise) {
        web = await eagerWebPromise;
        webReason = intent === 'general_wine' ? 'general_wine_topic' : 'off_topic_factual';
    } else {
        const shouldUseWebFallback = !smalltalk && allowWeb && (forceWeb || freshness || !strongInternal);
        web = shouldUseWebFallback
            ? await runLevel(LEVELS.WEB, () => (adapters.searchInternet || searchInternet)(query, { ...options, language }))
            : [];
        webReason = !shouldUseWebFallback ? null : forceWeb ? 'forced' : freshness ? 'freshness' : 'weak_internal';
    }
    const shouldUseWeb = Boolean(eagerWebPromise) || (!smalltalk && allowWeb && (forceWeb || freshness || !strongInternal));

    const evidence = sortEvidence([...internal, ...web], { webPriority: Boolean(eagerWebPromise) });
    const conflicts = detectConflicts(evidence);
    return {
        found: evidence.length > 0,
        evidence,
        attempts,
        used_levels: [...new Set(evidence.map((item) => item.level))],
        web_used: web.length > 0,
        web_attempted: shouldUseWeb,
        web_reason: web.length > 0 ? webReason : null,
        query_intent: intent,
        freshness_sensitive: freshness,
        catalog_intent: catalogIntent,
        conflicts,
        answer_policy: naturalAnswerPolicy(),
    };
}

const ANSWERABILITY_MODEL = process.env.ANSWERABILITY_MODEL || 'gemini-2.5-flash';
// Matches the evidence the main answer-generation prompt actually sees
// (textKnowledgeEvaluation.js's MAX_EVIDENCE_ITEMS=8, and the same 1200-char
// per-fragment cap used everywhere evidence is exposed publicly, e.g.
// publicEvidence()) -- the grader must judge against the same material the
// assistant is about to answer from, not a narrower slice of it. Confirmed
// via staging: the old 6-item/300-char limit made the grader reject
// questions (e.g. "Что такое Fetească Neagră?") that the full-context answer
// generator could genuinely cover.
const ANSWERABILITY_EVIDENCE_LIMIT = 8;
const ANSWERABILITY_FRAGMENT_CHARS = 1200;
const ANSWERABILITY_MAX_OUTPUT_TOKENS = 200;
// TEMP DIAGNOSTIC (staging investigation only): opt-in, verbose logging of
// the raw grader response so a systematic unparseable-output failure can be
// diagnosed from real traffic. Never enabled by default; must be turned on
// explicitly per-environment and removed once the investigation is closed.
const ANSWERABILITY_DEBUG_LOG = process.env.ANSWERABILITY_DEBUG_LOG === 'true';
const ANSWERABILITY_DEBUG_PREVIEW_CHARS = 1500;

function extractCheckText(response) {
    const text = typeof response?.text === 'string'
        ? response.text
        : response?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('');
    return String(text || '').trim();
}

// Claim classes -- see routeKnowledgeWithAnswerabilityGate(). The gate used
// to conflate "retrieval found nothing" with "the assistant may not answer".
// Those are different questions: a general oenology explanation (malolactic
// fermentation, why tannins feel drying, decanting, food-pairing principles)
// is safe to answer from the foundation model's own training with zero risk
// of inventing an unverifiable specific fact, so weak retrieval must not
// force a refusal there. A specific claim about a named entity/product (ABV,
// vintage, award, winemaker, price, stock, aging) is the opposite: without
// evidence attributed to the ASKED entity there is nothing honest to say.
const CLAIM_CLASSES = Object.freeze({
    GENERAL_KNOWLEDGE: 'general_knowledge',
    GROUNDING_REQUIRED: 'grounding_required',
});

// Asks for a specific, checkable attribute value rather than an explanation.
const SPECIFIC_ATTRIBUTE_RE = /(крепост|градус|алкогол|abv|винтаж|урожа|год[ау]?\b|выдерж|бочк[аеи]\s*\d|награ|медал|конкурс|винодел[ац]|энолог|владел|основан|цена|стоим|стоит|налич|склад|тираж|объ[её]м|адрес|телефон|часы работы|сайт|координат|рейтинг|балл|vintage|alcohol|award|medal|winemaker|founded|owner|price|stock|address|phone|opening|rating|score|preț|stoc|premiu|an\b)/iu;
// Asks for an explanation/definition/principle -- education, not a record.
const GENERAL_EXPLANATION_RE = /(что такое|чем отлич|в ч[её]м разниц|как[ ,]|почему|зачем|как[ой|ая|ие]*\s+(?:вообще|в принципе)|расскажи о сорт|объясн|принцип|как правильно|что значит|what is|what's|how do|how does|why|difference between|explain|ce este|de ce|cum se)/iu;

// Grape/variety names are capitalized multi-word proper nouns too, but a
// question about one is education, not a claim about a producer. They are
// removed before the proper-noun test below so "Чем отличается Каберне
// Совиньон от Мерло?" is not misread as an entity-specific question. This is
// a false-positive guard only -- an unlisted grape simply falls through to
// the conservative grounding_required default, never the other way around.
const GRAPE_VARIETY_RE = /(каберне|совиньон|мерло|шардоне|пино|рислинг|саперави|фет[яе]ск|feteasca|fetească|рара\s*нягр|негру|раркацители|алиготе|мускат|траминер|вионье|сира|шираз|мальбек|темпранильо|санджовезе|неббиоло|гренаш|карменер|виорика|cabernet|sauvignon|merlot|chardonnay|pinot|riesling|saperavi|aligote|muscat|traminer|viognier|syrah|shiraz|malbec|tempranillo|sangiovese|nebbiolo|grenache|carmenere|viorica|blanc|noir|gris|grigio)/giu;

// Deterministic, evidence-independent fallback for when the LLM grader is
// unreachable/unparseable. Deliberately conservative: anything naming a known
// winery, or asking for a specific checkable attribute, is GROUNDING_REQUIRED.
// Only a wine-related question that reads as an explanation AND names no known
// entity AND asks for no specific attribute may be treated as general.
function classifyClaimDependency(query, { knownEntityNames = KNOWN_WINERY_NAMES } = {}) {
    const norm = normalize(query);
    if (_mentionsKnownEntity(query, knownEntityNames)) return CLAIM_CLASSES.GROUNDING_REQUIRED;
    if (isCatalogQuery(query) || isFreshnessQuery(query)) return CLAIM_CLASSES.GROUNDING_REQUIRED;
    if (SPECIFIC_ATTRIBUTE_RE.test(norm)) return CLAIM_CLASSES.GROUNDING_REQUIRED;
    // A capitalized multi-word proper noun that isn't one of ours is still a
    // named entity (an unknown/fictional winery or a similarly-named one) --
    // exactly the case where a "general knowledge" pass would invent facts.
    const withoutGrapes = String(query || '').replace(GRAPE_VARIETY_RE, ' ');
    if (/(?:^|\s)(?:["«„]|[A-ZА-ЯЁĂÂÎȘȚ][\p{L}-]+\s+[A-ZА-ЯЁĂÂÎȘȚ][\p{L}-]+)/u.test(withoutGrapes)) {
        return CLAIM_CLASSES.GROUNDING_REQUIRED;
    }
    // _isWineRelated() is tuned for web-search routing and misses some
    // inflected/oenology vocabulary (Romanian "vinul", "decantează", tannin/
    // acidity talk). Widening it there would change routing behavior, which is
    // out of scope, so the extra stems are applied locally to this classifier
    // only.
    const wineTopic = _isWineRelated(query)
        || /(vin(?:ul|uri|urile|uri)?\b|decant|танин|tanin|tannin|кислотност|aciditate|acidity|купаж|blend|терпк|послевкус|аромат|бро[жд]ени|ferment|выдержк в дуб|дуб[ае]\b|oak)/iu.test(norm);
    if (wineTopic && GENERAL_EXPLANATION_RE.test(norm)) return CLAIM_CLASSES.GENERAL_KNOWLEDGE;
    return CLAIM_CLASSES.GROUNDING_REQUIRED;
}

function buildAnswerabilityPrompt(question, evidence) {
    const fragments = evidence.slice(0, ANSWERABILITY_EVIDENCE_LIMIT).map((item, index) => {
        const text = String(item.text || '').slice(0, ANSWERABILITY_FRAGMENT_CHARS);
        return `[${index + 1}] ${item.title || 'Fragment'}\n${text}`;
    }).join('\n\n');
    return `You are a strict grader, not an assistant. You are given a QUESTION and EVIDENCE fragments retrieved for it. Produce three independent judgements.

1. "answerable": does the EVIDENCE, taken by itself, contain enough information to give a direct, confident, factual answer to the QUESTION? Similarity or topical relatedness is NOT enough; the specific fact asked for must actually be present. This judgement is about the evidence only -- ignore what a well-trained model might know on its own.

2. "claim_class": what KIND of question is this, regardless of the evidence?
   - "general_knowledge": answering it well requires only general wine/oenology/gastronomy education that any competent sommelier knows -- grape variety characteristics and differences, winemaking and fermentation processes, tannins/acidity/oak/decanting/serving temperature, general food-pairing principles, wine styles and categories, general region or grape background. No claim about one specific named producer, product, bottle, vintage or price is needed.
   - "grounding_required": answering it correctly requires a specific verifiable fact about a NAMED entity or product -- alcohol percentage, vintage year, award, winemaker or owner name, founding date, address, opening hours, aging duration, price, stock, tasting notes of one specific bottling, or any producer-stated spec. Also use this when the question names a producer/brand/wine you cannot verify (including unknown, fictional or similarly-named ones).

3. "evidence_entity_match": if the QUESTION is about a specific named entity/wine/winery, do the EVIDENCE fragments actually concern THAT SAME entity?
   - "match": at least one fragment is genuinely about the entity asked about.
   - "mismatch": fragments are about a DIFFERENT producer/wine than the one asked about (or about the region in general, with nothing on the asked entity).
   - "not_applicable": the question names no specific entity.

Respond with ONLY strict JSON, no markdown, no prose outside the JSON:
{"answerable": true or false, "claim_class": "general_knowledge" or "grounding_required", "evidence_entity_match": "match" or "mismatch" or "not_applicable", "reason": "one short sentence"}

QUESTION: ${question}

EVIDENCE:
${fragments}`;
}

// Sees only the question and the retrieved evidence text -- no persona,
// system prompt, or conversation history -- so its verdict reflects
// whether THIS evidence answers THIS question, nothing else.
async function checkAnswerability(question, evidence, {
    generateContent,
    apiKey = process.env.GEMINI_API_KEY || '',
    model = ANSWERABILITY_MODEL,
} = {}) {
    if (!evidence.length) return { answerable: false, reason: 'no_evidence', claimClass: null, entityMatch: null };
    const prompt = buildAnswerabilityPrompt(question, evidence);
    let response;
    try {
        if (typeof generateContent === 'function') {
            response = await generateContent({ model, prompt });
        } else if (!apiKey) {
            // Unknown, not confirmed: for a live wine assistant, "the grader
            // is unreachable" must never read the same as "yes, this
            // evidence answers the question" -- that would silently skip
            // the web fallback and let a random topically-similar fragment
            // pass as a verified answer. null lets the gate below route this
            // exactly like answerable:false (try web if allowed).
            return { answerable: null, reason: 'answerability_check_unavailable' };
        } else {
            const { GoogleGenAI } = require('@google/genai');
            const ai = new GoogleGenAI({ apiKey });
            response = await ai.models.generateContent({
                model,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                config: {
                    temperature: 0,
                    maxOutputTokens: ANSWERABILITY_MAX_OUTPUT_TOKENS,
                    // Root cause of the systematic unparseable-output bug,
                    // confirmed via staging diagnostics: gemini-2.5-flash is
                    // a thinking model -- by default it spends part of the
                    // output-token budget on invisible reasoning before
                    // emitting any visible text, so a small maxOutputTokens
                    // was being consumed entirely by thinking and the model
                    // got cut off (finishReason: MAX_TOKENS) after literally
                    // '{"answerable' with zero characters of real output.
                    // This is a one-field true/false classification task; it
                    // needs no reasoning budget at all.
                    thinkingConfig: { thinkingBudget: 0 },
                    // Structured JSON mode: the SDK enforces valid JSON
                    // output matching this schema directly, instead of us
                    // hoping the model followed a "respond with only JSON"
                    // instruction in the prompt text.
                    responseMimeType: 'application/json',
                    // Extended in the answerability-gate sprint: the SAME
                    // single call now also returns the claim class and the
                    // evidence/entity attribution verdict, so splitting
                    // "retrieval failed" from "may not answer" costs ZERO
                    // extra round-trips.
                    responseSchema: {
                        type: 'object',
                        properties: {
                            answerable: { type: 'boolean' },
                            claim_class: { type: 'string', enum: ['general_knowledge', 'grounding_required'] },
                            evidence_entity_match: { type: 'string', enum: ['match', 'mismatch', 'not_applicable'] },
                            reason: { type: 'string' },
                        },
                        required: ['answerable', 'claim_class', 'evidence_entity_match', 'reason'],
                    },
                },
            });
        }
    } catch (error) {
        // TEMP DIAGNOSTIC (staging only, remove once the unparseable-output
        // investigation is closed): surface the actual HTTP/SDK failure so
        // it's distinguishable from a normal outage in logs.
        if (ANSWERABILITY_DEBUG_LOG) {
            console.warn('[answerability:debug] generateContent threw', {
                message: error?.message,
                status: error?.status ?? error?.code ?? null,
            });
        }
        // Same reasoning as the missing-apiKey branch above: an outage in
        // the grader is "unknown", not a pass.
        return { answerable: null, reason: 'answerability_check_error' };
    }
    const raw = extractCheckText(response);
    // TEMP DIAGNOSTIC (staging only): finishReason tells us directly
    // whether the model was cut off mid-output (MAX_TOKENS) vs. stopped
    // normally (STOP) vs. something else (SAFETY, RECITATION, ...).
    const finishReason = response?.candidates?.[0]?.finishReason ?? null;
    if (ANSWERABILITY_DEBUG_LOG) {
        console.warn('[answerability:debug] raw grader response', {
            finishReason,
            rawLength: raw.length,
            rawPreview: raw.slice(0, ANSWERABILITY_DEBUG_PREVIEW_CHARS),
        });
    }
    let parsed;
    try {
        const match = raw.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(match ? match[0] : raw);
    } catch {
        if (ANSWERABILITY_DEBUG_LOG) {
            console.warn('[answerability:debug] JSON.parse failed', { finishReason, rawLength: raw.length });
        }
        return { answerable: null, reason: 'answerability_check_unparseable' };
    }
    if (ANSWERABILITY_DEBUG_LOG) {
        console.warn('[answerability:debug] parsed ok', { finishReason, answerable: parsed?.answerable });
    }
    // The model responded with parseable JSON but no valid boolean field --
    // still "unknown", not a pass, for the same reason as above.
    const answerable = typeof parsed?.answerable === 'boolean' ? parsed.answerable : null;
    const reason = typeof parsed?.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 200)
        : (answerable === true ? 'answerable' : answerable === false ? 'evidence_does_not_answer_question' : 'answerability_check_unparseable');
    // Both extra fields are optional at this layer: an older/degraded grader
    // response that only carries `answerable` still parses, and the gate
    // falls back to the deterministic classifier rather than assuming
    // "general knowledge" (which would be the hallucination-friendly guess).
    const claimClass = parsed?.claim_class === CLAIM_CLASSES.GENERAL_KNOWLEDGE
        || parsed?.claim_class === CLAIM_CLASSES.GROUNDING_REQUIRED
        ? parsed.claim_class
        : null;
    const entityMatch = ['match', 'mismatch', 'not_applicable'].includes(parsed?.evidence_entity_match)
        ? parsed.evidence_entity_match
        : null;
    return { answerable, reason, claimClass, entityMatch };
}

// Wraps routeKnowledge() with an explicit answerability gate: retrieval
// can return `found: true` (fragments exist) while none of them actually
// answer the question -- topical similarity is not the same as coverage.
// `found` keeps meaning "evidence was retrieved"; `answerable` is the new,
// separate signal for "the retrieved evidence actually supports an answer".
// Web is only ever attempted here when the caller allows it AND the
// evidence-only check says it can't answer -- freshness/forced web (already
// decided inside routeKnowledge) is left untouched and never double-checked.
async function routeKnowledgeWithAnswerabilityGate(query, options = {}) {
    const base = await routeKnowledge(query, options);
    const deterministicClass = classifyClaimDependency(query, options.knownEntityNames ? { knownEntityNames: options.knownEntityNames } : {});
    if (!base.found) {
        // No evidence at all is still not automatically a refusal: for a
        // general-knowledge question the model's own training is a legitimate,
        // low-risk source. The refusal only stands for grounding-required
        // claims, where there is nothing honest to say without evidence.
        return {
            ...base,
            answerable: false,
            answerabilityReason: 'no_evidence',
            claim_class: deterministicClass,
            evidence_entity_match: null,
        };
    }
    // Freshness-triggered web (routeKnowledge's own logic, e.g. price/hours
    // questions) is trusted as-is -- time-sensitive facts don't benefit from
    // a separate LLM grading pass, and re-grading here would just be an
    // extra paid call for no real gain. Eager web (general_wine/
    // off_topic_factual intent) is NOT skipped here -- the combined
    // internal+web evidence still needs to be graded, since eager web
    // firing doesn't by itself guarantee the assembled evidence actually
    // answers the question.
    if (base.freshness_sensitive && base.web_used) {
        return {
            ...base,
            answerable: true,
            answerabilityReason: null,
            claim_class: CLAIM_CLASSES.GROUNDING_REQUIRED,
            evidence_entity_match: null,
        };
    }

    const { answerable: rawAnswerable, reason: rawReason, claimClass, entityMatch } =
        await checkAnswerability(query, base.evidence, options.answerabilityModel);
    // Grader silence (null claimClass) must never widen permission: fall back
    // to the conservative deterministic classifier, which defaults to
    // grounding_required for anything naming an entity or asking for a
    // specific attribute.
    const resolvedClass = claimClass || deterministicClass;

    // Wrong-entity evidence: fragments about Winery B must not be allowed to
    // stand in as an answer about Winery A just because they were in the same
    // retrieved batch. This is the ~22% unsupported entity-specific claim
    // failure mode. Only applies to grounding-required claims -- for general
    // education, "the fragments are about someone else" is irrelevant.
    const entityMismatch = entityMatch === 'mismatch' && resolvedClass === CLAIM_CLASSES.GROUNDING_REQUIRED;
    const answerable = entityMismatch ? false : rawAnswerable;
    const reason = entityMismatch ? 'evidence_entity_mismatch' : rawReason;

    // Web fallback fires whenever the check did NOT confirm the evidence
    // answers the question -- that's answerable === false (checked and
    // rejected) OR answerable === null (unknown -- grader unavailable or
    // unparseable). Treating "unknown" the same as "no" here is the whole
    // point: a live assistant must never silently skip going to the web
    // just because its own grader happened to be down. If eager web already
    // ran (base.web_used) there is nothing further to fetch -- the combined
    // evidence the check just graded already included it.
    if (answerable === true || options.allowWeb === false || base.web_used) {
        return {
            ...base,
            answerable,
            answerabilityReason: reason,
            claim_class: resolvedClass,
            evidence_entity_match: entityMatch,
        };
    }

    const web = await (options.adapters?.searchInternet || searchInternet)(query, { ...options, language: options.language || null });
    const evidence = sortEvidence([...base.evidence, ...web]);
    const webConfirmed = web.length > 0;
    return {
        ...base,
        evidence,
        used_levels: [...new Set(evidence.map((item) => item.level))],
        web_used: webConfirmed,
        web_attempted: true,
        // If the web pass actually turned up something, treat the question
        // as answered -- the model gets fresh, real evidence to answer from
        // confidently. If web found nothing either, the honest signal from
        // the check (false/null) stands, and callers must present this as
        // "insufficient", never as a confirmed answer.
        answerable: webConfirmed ? true : answerable,
        answerabilityReason: webConfirmed ? 'confirmed_via_web_fallback' : reason,
        claim_class: resolvedClass,
        // The web pass brought in evidence the grader never saw, so the
        // original mismatch verdict no longer describes the current evidence
        // set. It is still worth propagating: the assistant is told to check
        // that a fact belongs to the asked entity before stating it, which
        // costs nothing and is the exact failure this sprint targets. We do
        // NOT spend a second grading round-trip to re-confirm.
        evidence_entity_match: webConfirmed && entityMismatch ? 'unverified_after_web' : entityMatch,
    };
}

module.exports = {
    LEVELS,
    CLAIM_CLASSES,
    classifyClaimDependency,
    routeKnowledge,
    routeKnowledgeWithAnswerabilityGate,
    checkAnswerability,
    searchCanonical,
    searchCatalog,
    searchDocuments,
    searchInternet,
    isFreshnessQuery,
    isCatalogQuery,
    classifyQueryIntent,
    KNOWN_WINERY_NAMES,
    naturalAnswerPolicy,
    detectConflicts,
    queryTokens,
};
