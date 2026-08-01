'use strict';

const db = require('./db');
const { search } = require('./search');
const { searchWeb } = require('./webSearch');

const LEVELS = Object.freeze({
    CANONICAL: 'canonical',
    CATALOG: 'catalog',
    DOCUMENTS: 'documents',
    WEB: 'web',
});

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

function isFreshnessQuery(query) {
    return /\b(сейчас|сегодня|актуальн|цена|стоим|налич|купить|где купить|расписан|открыт|час|event|today|current|price|stock|availability|opening|schedule|acum|astăzi|preț|stoc|program)\b/iu.test(query);
}

function isCatalogQuery(query) {
    return /\b(цена|стоим|налич|купить|где купить|заказать|фото|бутылк|price|stock|availability|buy|order|image|preț|stoc|cumpăr|comand)\b/iu.test(query);
}

function confidenceRank(value) {
    return ({ verified: 0, high: 1, medium: 2, low: 3, unverified: 4 })[value] ?? 3;
}

async function searchCanonical(query, { limit = 8 } = {}) {
    if (!db.isEnabled()) return [];
    const pool = db.getPool();
    const needle = `%${normalize(query)}%`;
    const { rows } = await pool.query(`
        SELECT id, entity_id, entity_type, field_name, normalized_value, raw_value,
               confidence, validation_status, source_url, source_type, source_domain,
               evidence, verified_at, expires_at
        FROM entity_facts
        WHERE active = TRUE
          AND validation_status IN ('approved','validated')
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (
            lower(entity_id) LIKE $1 OR
            lower(COALESCE(field_name,'')) LIKE $1 OR
            lower(COALESCE(normalized_value,'')) LIKE $1 OR
            lower(COALESCE(raw_value,'')) LIKE $1
          )
        ORDER BY
          CASE validation_status WHEN 'approved' THEN 0 ELSE 1 END,
          CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
          COALESCE(verified_at, NOW()) DESC
        LIMIT $2
    `, [needle, limit]);
    return rows.map((row) => ({
        level: LEVELS.CANONICAL,
        text: `${row.field_name}: ${row.raw_value || row.normalized_value}`,
        title: row.entity_id,
        source: row.source_url || row.source_domain || 'entity_facts',
        source_type: row.source_type || 'canonical',
        confidence: row.confidence === 'high' ? 'verified' : row.confidence,
        provenance: {
            fact_id: row.id,
            entity_id: row.entity_id,
            validation_status: row.validation_status,
            verified_at: row.verified_at,
        },
    }));
}

async function searchCatalog(query, { limit = 8 } = {}) {
    if (!db.isEnabled()) return [];
    const pool = db.getPool();
    try {
        const needle = `%${normalize(query)}%`;
        const { rows } = await pool.query(`
            SELECT id, external_id, wine_entity_id, title, vintage, volume_ml,
                   price, currency, availability, stock_quantity, product_url,
                   image_url, last_synced_at
            FROM catalog_products
            WHERE lower(title) LIKE $1
               OR lower(COALESCE(external_id,'')) LIKE $1
               OR lower(COALESCE(wine_entity_id,'')) LIKE $1
            ORDER BY
              CASE WHEN availability IN ('in_stock','available') THEN 0 ELSE 1 END,
              last_synced_at DESC NULLS LAST
            LIMIT $2
        `, [needle, limit]);
        return rows.map((row) => ({
            level: LEVELS.CATALOG,
            text: row.title,
            title: row.title,
            source: row.product_url || 'wine.md',
            source_type: 'partner_catalog',
            confidence: 'verified',
            catalog: {
                product_id: row.id,
                external_id: row.external_id,
                wine_entity_id: row.wine_entity_id,
                vintage: row.vintage,
                volume_ml: row.volume_ml,
                price: row.price,
                currency: row.currency,
                availability: row.availability,
                stock_quantity: row.stock_quantity,
                product_url: row.product_url,
                image_url: row.image_url,
                last_synced_at: row.last_synced_at,
            },
        }));
    } catch (error) {
        if (error && error.code === '42P01') return [];
        throw error;
    }
}

async function searchDocuments(query, { language = null, limit = 8 } = {}) {
    const result = await search(query, { language, limit });
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

async function searchInternet(query, { language = null, limit = 5 } = {}) {
    const result = await searchWeb(query, { language, maxResults: limit });
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
            'Answer directly from the strongest available evidence.',
            'Do not say that the internal database lacked information.',
            'Do not announce that web search was used.',
            'For volatile facts such as price, stock, hours, schedules, or events, use current-language qualifiers such as “сейчас” or “на данный момент”.',
            'When evidence is insufficient or conflicting, state the uncertainty plainly without exposing internal routing.',
        ],
    };
}

async function routeKnowledge(query, options = {}) {
    const language = options.language || null;
    const allowWeb = options.allowWeb !== false;
    const forceWeb = options.forceWeb === true;
    const freshness = isFreshnessQuery(query);
    const catalogIntent = isCatalogQuery(query);
    const attempts = [];

    const canonical = await searchCanonical(query, options).catch((error) => {
        attempts.push({ level: LEVELS.CANONICAL, status: 'error', error: error.message });
        return [];
    });
    attempts.push({ level: LEVELS.CANONICAL, status: canonical.length ? 'found' : 'empty', count: canonical.length });

    let catalog = [];
    if (catalogIntent || freshness) {
        catalog = await searchCatalog(query, options).catch((error) => {
            attempts.push({ level: LEVELS.CATALOG, status: 'error', error: error.message });
            return [];
        });
        attempts.push({ level: LEVELS.CATALOG, status: catalog.length ? 'found' : 'empty', count: catalog.length });
    }

    const documents = await searchDocuments(query, { ...options, language }).catch((error) => {
        attempts.push({ level: LEVELS.DOCUMENTS, status: 'error', error: error.message });
        return [];
    });
    attempts.push({ level: LEVELS.DOCUMENTS, status: documents.length ? 'found' : 'empty', count: documents.length });

    const internal = [...canonical, ...catalog, ...documents];
    const strongInternal = canonical.length > 0 || catalog.length > 0 || documents.some((item) => (item.relevance_score || 0) >= 0.45);
    const shouldUseWeb = allowWeb && (forceWeb || freshness || !strongInternal);
    let web = [];
    if (shouldUseWeb) {
        web = await searchInternet(query, { ...options, language }).catch((error) => {
            attempts.push({ level: LEVELS.WEB, status: 'error', error: error.message });
            return [];
        });
        attempts.push({ level: LEVELS.WEB, status: web.length ? 'found' : 'empty', count: web.length });
    }

    const evidence = [...internal, ...web].sort((a, b) => {
        const levelRank = { canonical: 0, catalog: 1, documents: 2, web: 3 };
        const lr = (levelRank[a.level] ?? 9) - (levelRank[b.level] ?? 9);
        if (lr !== 0) return lr;
        const cr = confidenceRank(a.confidence) - confidenceRank(b.confidence);
        if (cr !== 0) return cr;
        return (b.relevance_score || 0) - (a.relevance_score || 0);
    });

    return {
        found: evidence.length > 0,
        evidence,
        attempts,
        used_levels: [...new Set(evidence.map((item) => item.level))],
        web_used: web.length > 0,
        freshness_sensitive: freshness,
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
};
