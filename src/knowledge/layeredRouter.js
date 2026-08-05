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
        provenance: { url: row.url },
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
        ],
    };
}

function sortEvidence(items) {
    return items.sort((a, b) => {
        const lr = (LEVEL_RANK[a.level] ?? 9) - (LEVEL_RANK[b.level] ?? 9);
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

    const canonical = await runLevel(LEVELS.CANONICAL, () =>
        (adapters.searchCanonical || searchCanonical)(query, options));

    const catalog = (catalogIntent || freshness)
        ? await runLevel(LEVELS.CATALOG, () => (adapters.searchCatalog || searchCatalog)(query, options))
        : [];

    const documents = await runLevel(LEVELS.DOCUMENTS, () =>
        (adapters.searchDocuments || searchDocuments)(query, { ...options, language }));

    const internal = [...canonical, ...catalog, ...documents];
    const strongInternal = canonical.length > 0
        || catalog.length > 0
        || documents.some((item) => Number(item.relevance_score || 0) >= Number(options.documentThreshold || 0.45));
    const shouldUseWeb = allowWeb && (forceWeb || freshness || !strongInternal);
    const web = shouldUseWeb
        ? await runLevel(LEVELS.WEB, () => (adapters.searchInternet || searchInternet)(query, { ...options, language }))
        : [];

    const evidence = sortEvidence([...internal, ...web]);
    const conflicts = detectConflicts(evidence);
    return {
        found: evidence.length > 0,
        evidence,
        attempts,
        used_levels: [...new Set(evidence.map((item) => item.level))],
        web_used: web.length > 0,
        web_attempted: shouldUseWeb,
        freshness_sensitive: freshness,
        catalog_intent: catalogIntent,
        conflicts,
        answer_policy: naturalAnswerPolicy(),
    };
}

const ANSWERABILITY_MODEL = process.env.ANSWERABILITY_MODEL || 'gemini-2.5-flash';
const ANSWERABILITY_EVIDENCE_LIMIT = 6;
const ANSWERABILITY_FRAGMENT_CHARS = 300;

function extractCheckText(response) {
    const text = typeof response?.text === 'string'
        ? response.text
        : response?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('');
    return String(text || '').trim();
}

function buildAnswerabilityPrompt(question, evidence) {
    const fragments = evidence.slice(0, ANSWERABILITY_EVIDENCE_LIMIT).map((item, index) => {
        const text = String(item.text || '').slice(0, ANSWERABILITY_FRAGMENT_CHARS);
        return `[${index + 1}] ${item.title || 'Fragment'}\n${text}`;
    }).join('\n\n');
    return `You are a strict grader, not an assistant. You are given a QUESTION and EVIDENCE fragments retrieved for it. Decide only whether the EVIDENCE, taken by itself, contains enough information to give a direct, confident, factual answer to the QUESTION -- similarity or topical relatedness is not enough; the specific fact asked for must actually be present.

Respond with ONLY strict JSON, no markdown, no prose outside the JSON: {"answerable": true or false, "reason": "one short sentence"}

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
    if (!evidence.length) return { answerable: false, reason: 'no_evidence' };
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
                config: { temperature: 0, maxOutputTokens: 80 },
            });
        }
    } catch (error) {
        // Same reasoning as the missing-apiKey branch above: an outage in
        // the grader is "unknown", not a pass.
        return { answerable: null, reason: 'answerability_check_error' };
    }
    const raw = extractCheckText(response);
    let parsed;
    try {
        const match = raw.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(match ? match[0] : raw);
    } catch {
        return { answerable: null, reason: 'answerability_check_unparseable' };
    }
    // The model responded with parseable JSON but no valid boolean field --
    // still "unknown", not a pass, for the same reason as above.
    const answerable = typeof parsed?.answerable === 'boolean' ? parsed.answerable : null;
    const reason = typeof parsed?.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 200)
        : (answerable === true ? 'answerable' : answerable === false ? 'evidence_does_not_answer_question' : 'answerability_check_unparseable');
    return { answerable, reason };
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
    if (!base.found || base.web_used) {
        return { ...base, answerable: base.found, answerabilityReason: base.found ? null : 'no_evidence' };
    }

    const { answerable, reason } = await checkAnswerability(query, base.evidence, options.answerabilityModel);

    // Web fallback fires whenever the check did NOT confirm the evidence
    // answers the question -- that's answerable === false (checked and
    // rejected) OR answerable === null (unknown -- grader unavailable or
    // unparseable). Treating "unknown" the same as "no" here is the whole
    // point: a live assistant must never silently skip going to the web
    // just because its own grader happened to be down.
    if (answerable === true || options.allowWeb === false) {
        return { ...base, answerable, answerabilityReason: reason };
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
    };
}

module.exports = {
    LEVELS,
    routeKnowledge,
    routeKnowledgeWithAnswerabilityGate,
    checkAnswerability,
    searchCanonical,
    searchCatalog,
    searchDocuments,
    searchInternet,
    isFreshnessQuery,
    isCatalogQuery,
    naturalAnswerPolicy,
    detectConflicts,
    queryTokens,
};
