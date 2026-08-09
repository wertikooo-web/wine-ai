'use strict';

const crypto = require('crypto');
const db = require('../knowledge/db');
const { findMentionedEntities } = require('../knowledge/entityResolver');

const DEFAULT_CURRENCY = 'MDL';
const MIN_SYNC_INTERVAL_MS = Math.max(5, Number(process.env.WINEMD_SYNC_INTERVAL_MINUTES || 30)) * 60 * 1000;
const STALE_AFTER_MS = Math.max(60, Number(process.env.WINEMD_STALE_AFTER_MINUTES || 24 * 60)) * 60 * 1000;
let schemaPromise = null;
let syncPromise = null;
let lastAttemptAt = 0;

function normalize(value) {
    return String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function stableId(value) {
    return `cat_${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 20)}`;
}

function productsFromPayload(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.products)) return payload.products;
    if (Array.isArray(payload?.items)) return payload.items;
    if (payload && typeof payload === 'object' && (payload.id || payload.external_id || payload.externalId || payload.sku)) return [payload];
    return [];
}

function normalizeProduct(raw) {
    const externalId = String(raw.external_id ?? raw.externalId ?? raw.id ?? raw.sku ?? '').trim();
    const title = String(raw.title ?? raw.name ?? raw.product_name ?? '').trim();
    if (!externalId || !title) return null;
    const numberOrNull = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
    return {
        externalId,
        title,
        vintage: raw.vintage == null ? null : String(raw.vintage),
        volumeMl: numberOrNull(raw.volume_ml ?? raw.volumeMl ?? raw.volume),
        price: numberOrNull(raw.price),
        currency: String(raw.currency || DEFAULT_CURRENCY).trim() || DEFAULT_CURRENCY,
        availability: String(raw.availability ?? raw.stock_status ?? (raw.in_stock === true ? 'in_stock' : raw.in_stock === false ? 'out_of_stock' : 'unknown')),
        stockQuantity: numberOrNull(raw.stock_quantity ?? raw.stockQuantity ?? raw.quantity),
        productUrl: raw.product_url ?? raw.productUrl ?? raw.url ?? null,
        imageUrl: raw.image_url ?? raw.imageUrl ?? raw.image ?? null,
        raw,
    };
}

async function ensureSchema(pool = db.getPool()) {
    if (!pool) return false;
    if (!schemaPromise) {
        schemaPromise = (async () => {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS catalog_sync_jobs (
                    id TEXT PRIMARY KEY,
                    mode TEXT NOT NULL,
                    status TEXT NOT NULL,
                    products_seen INT NOT NULL DEFAULT 0,
                    products_changed INT NOT NULL DEFAULT 0,
                    products_failed INT NOT NULL DEFAULT 0,
                    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    finished_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS catalog_sync_errors (
                    id BIGSERIAL PRIMARY KEY,
                    job_id TEXT REFERENCES catalog_sync_jobs(id) ON DELETE CASCADE,
                    external_id TEXT,
                    error TEXT NOT NULL,
                    payload JSONB,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS catalog_products (
                    id TEXT PRIMARY KEY,
                    external_id TEXT NOT NULL UNIQUE,
                    wine_entity_id TEXT,
                    title TEXT NOT NULL,
                    normalized_title TEXT NOT NULL,
                    vintage TEXT,
                    volume_ml INT,
                    price NUMERIC,
                    currency TEXT NOT NULL DEFAULT 'MDL',
                    availability TEXT NOT NULL DEFAULT 'unknown',
                    stock_quantity NUMERIC,
                    product_url TEXT,
                    image_url TEXT,
                    raw_payload JSONB,
                    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `);
            await pool.query('CREATE INDEX IF NOT EXISTS idx_catalog_products_normalized_title ON catalog_products(normalized_title)');
            await pool.query('CREATE INDEX IF NOT EXISTS idx_catalog_products_entity ON catalog_products(wine_entity_id)');
            await pool.query('CREATE INDEX IF NOT EXISTS idx_catalog_products_availability ON catalog_products(availability)');
            return true;
        })().catch((error) => {
            schemaPromise = null;
            throw error;
        });
    }
    return schemaPromise;
}

// Links a catalog product title to a canonical entity from the shared
// knowledge/entity-aliases.json registry (the single source of verified
// winery/producer/brand/grapes names). Word-boundary mention extraction only:
// a product titled "Cricova Brut" resolves to the "cricova" entity, while
// a generic title ("Vin alb sec") yields no link. Winery/divin-producer
// mentions are preferred over bare grape varieties so the product lands on
// its producer's canonical entity when both are named.
function matchEntity(title) {
    const mentions = findMentionedEntities(title);
    if (!mentions.length) return null;
    const preferred = mentions.find((mention) => ['winery', 'divin-producer', 'platform'].includes(mention.entityType));
    return (preferred || mentions[0]).entityId;
}

async function syncPayload(payload, { mode = 'manual', pool = db.getPool() } = {}) {
    if (!pool) throw Object.assign(new Error('PostgreSQL is required for catalog sync'), { code: 'POSTGRES_REQUIRED' });
    await ensureSchema(pool);
    const products = productsFromPayload(payload);
    const jobId = `catalog_job_${crypto.randomUUID()}`;
    await pool.query(`INSERT INTO catalog_sync_jobs(id, mode, status) VALUES($1,$2,'running')`, [jobId, mode]);
    let changed = 0;
    let failed = 0;

    for (const raw of products) {
        const product = normalizeProduct(raw);
        if (!product) {
            failed += 1;
            await pool.query(`INSERT INTO catalog_sync_errors(job_id,error,payload) VALUES($1,'Missing product id or title',$2::jsonb)`, [jobId, JSON.stringify(raw)]);
            continue;
        }
        try {
            const wineEntityId = matchEntity(product.title);
            const result = await pool.query(`
                INSERT INTO catalog_products(
                    id, external_id, wine_entity_id, title, normalized_title, vintage, volume_ml,
                    price, currency, availability, stock_quantity, product_url, image_url,
                    raw_payload, last_synced_at, updated_at
                ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,NOW(),NOW())
                ON CONFLICT(external_id) DO UPDATE SET
                    wine_entity_id = COALESCE(EXCLUDED.wine_entity_id, catalog_products.wine_entity_id),
                    title = EXCLUDED.title,
                    normalized_title = EXCLUDED.normalized_title,
                    vintage = EXCLUDED.vintage,
                    volume_ml = EXCLUDED.volume_ml,
                    price = EXCLUDED.price,
                    currency = EXCLUDED.currency,
                    availability = EXCLUDED.availability,
                    stock_quantity = EXCLUDED.stock_quantity,
                    product_url = EXCLUDED.product_url,
                    image_url = EXCLUDED.image_url,
                    raw_payload = EXCLUDED.raw_payload,
                    last_synced_at = NOW(),
                    updated_at = NOW()
                RETURNING id
            `, [
                stableId(product.externalId), product.externalId, wineEntityId, product.title,
                normalize(product.title), product.vintage, product.volumeMl, product.price,
                product.currency, product.availability, product.stockQuantity,
                product.productUrl, product.imageUrl, JSON.stringify(product.raw),
            ]);
            if (result.rowCount) changed += 1;
        } catch (error) {
            failed += 1;
            await pool.query(`INSERT INTO catalog_sync_errors(job_id,external_id,error,payload) VALUES($1,$2,$3,$4::jsonb)`, [jobId, product.externalId, error.message, JSON.stringify(raw)]);
        }
    }

    await pool.query(`
        UPDATE catalog_sync_jobs
        SET status=$2, products_seen=$3, products_changed=$4, products_failed=$5, finished_at=NOW()
        WHERE id=$1
    `, [jobId, failed ? 'completed_with_errors' : 'completed', products.length, changed, failed]);
    return { jobId, productsSeen: products.length, productsChanged: changed, productsFailed: failed };
}

async function syncRemote({ mode = 'scheduled', sourceUrl = process.env.WINEMD_CATALOG_URL, fetchImpl = globalThis.fetch, pool = db.getPool() } = {}) {
    if (!sourceUrl) throw Object.assign(new Error('WINEMD_CATALOG_URL is not configured'), { code: 'CATALOG_URL_NOT_CONFIGURED' });
    const response = await fetchImpl(sourceUrl, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw Object.assign(new Error(`Wine.md catalog returned HTTP ${response.status}`), { code: 'CATALOG_FETCH_FAILED' });
    return syncPayload(await response.json(), { mode, pool });
}

async function ensureFreshCatalog(options = {}) {
    if (!process.env.WINEMD_CATALOG_URL || !db.isEnabled()) return { attempted: false };
    const now = Date.now();
    if (syncPromise) return syncPromise;
    if (now - lastAttemptAt < MIN_SYNC_INTERVAL_MS) return { attempted: false, throttled: true };
    lastAttemptAt = now;
    syncPromise = syncRemote({ mode: 'lazy', ...options })
        .then((result) => ({ attempted: true, ok: true, result }))
        .catch((error) => ({ attempted: true, ok: false, error: error.message }))
        .finally(() => { syncPromise = null; });
    return syncPromise;
}

async function searchCatalog(query, { limit = 8, pool = db.getPool(), refresh = true } = {}) {
    if (!pool) return [];
    await ensureSchema(pool);
    if (refresh) await ensureFreshCatalog({ pool });
    const tokens = normalize(query).split(/\s+/).filter((token) => token.length >= 2).slice(0, 8);
    if (!tokens.length) return [];
    const clauses = tokens.map((_, index) => `(normalized_title LIKE $${index + 1} OR lower(COALESCE(external_id,'')) LIKE $${index + 1} OR lower(COALESCE(wine_entity_id,'')) LIKE $${index + 1})`);
    const params = tokens.map((token) => `%${token}%`);
    params.push(limit);
    const { rows } = await pool.query(`
        SELECT id, external_id, wine_entity_id, title, vintage, volume_ml, price, currency,
               availability, stock_quantity, product_url, image_url, last_synced_at
        FROM catalog_products
        WHERE ${clauses.join(' AND ')}
        ORDER BY
          CASE WHEN availability IN ('in_stock','available') THEN 0 ELSE 1 END,
          last_synced_at DESC,
          title ASC
        LIMIT $${params.length}
    `, params);
    return rows;
}

// "Where to buy" resolution: products that match a wine card id, its
// canonical entity id, or the product title. Never triggers a sync (that
// would turn every "where to buy" tap into a live fetch) and never returns
// stale rows as if they were current -- last_synced_at is always surfaced so
// the consumer can flag age.
async function findCatalogProductsById(idValue, { limit = 8, pool = db.getPool() } = {}) {
    if (!pool || !String(idValue || '').trim()) return [];
    await ensureSchema(pool);
    const value = String(idValue).trim();
    const { rows } = await pool.query(`
        SELECT id, external_id, wine_entity_id, title, vintage, volume_ml, price, currency,
               availability, stock_quantity, product_url, image_url, last_synced_at
        FROM catalog_products
        WHERE external_id = $1
           OR wine_entity_id = $1
           OR normalized_title LIKE '%' || lower($1) || '%'
        ORDER BY
          CASE WHEN availability IN ('in_stock','available') THEN 0 ELSE 1 END,
          last_synced_at DESC
        LIMIT $2
    `, [value, limit]);
    return rows;
}

// Observability report for the admin surface (Phase 3): total products,
// how many are linked to a canonical entity vs unmatched, stale rows, the
// state of the last sync job, and sync failures. Pure read path -- never
// triggers a sync, never writes.
async function getCatalogStatus({ pool = db.getPool() } = {}) {
    if (!pool) return { enabled: false, products: null, last_sync: null, sync_errors: [], stale: null };
    await ensureSchema(pool);
    const [products, lastSync, errors] = await Promise.all([
        pool.query(`
            SELECT COUNT(*) AS total,
                   COUNT(wine_entity_id) AS linked,
                   COUNT(*) FILTER (WHERE wine_entity_id IS NULL) AS unmatched,
                   COUNT(*) FILTER (WHERE availability IN ('in_stock','available')) AS in_stock,
                   COUNT(*) FILTER (WHERE last_synced_at < NOW() - ($1 * INTERVAL '1 millisecond')) AS stale
            FROM catalog_products
        `, [STALE_AFTER_MS]),
        pool.query(`
            SELECT id, mode, status, products_seen, products_changed, products_failed,
                   started_at, finished_at
            FROM catalog_sync_jobs
            ORDER BY started_at DESC
            LIMIT 1
        `),
        pool.query(`
            SELECT job_id, external_id, error, created_at
            FROM catalog_sync_errors
            ORDER BY created_at DESC
            LIMIT 10
        `),
    ]);
    return {
        enabled: true,
        configured: Boolean(process.env.WINEMD_CATALOG_URL),
        stale_after_minutes: Math.round(STALE_AFTER_MS / 60000),
        snapshot: products.rows[0] || null,
        last_sync: lastSync.rows[0] || null,
        sync_errors: (errors.rows || []).map((row) => ({
            job_id: row.job_id,
            external_id: row.external_id,
            error: row.error,
            created_at: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
        })),
    };
}

module.exports = {
    ensureSchema,
    ensureFreshCatalog,
    searchCatalog,
    syncPayload,
    syncRemote,
    normalizeProduct,
    productsFromPayload,
    matchEntity,
    getCatalogStatus,
    findCatalogProductsById,
};
