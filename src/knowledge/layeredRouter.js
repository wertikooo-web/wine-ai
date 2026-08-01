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

function isFreshnessQuery(query) {
    return /\b(сейчас|сегодня|актуальн|цена|стоим|налич|купить|где купить|расписан|открыт|час|новост|событ|event|today|current|price|stock|availability|opening|schedule|acum|astăzi|preț|stoc|program|eveniment)\b/iu.test(query);
}

function isCatalogQuery(query) {
    return /\b(цена|стоим|налич|купить|где купить|заказать|фото|бутылк|price|stock|availability|buy|order|image|preț|stoc|cumpăr|comand)\b/iu.test(query);
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

module.exports = {
    LEVELS,
    routeKnowledge,
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
