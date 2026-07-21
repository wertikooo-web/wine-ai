'use strict';

/**
 * WINE AI KOS - Source Registry Repository (Step 2C.1)
 *
 * Implements KOS Source entity CRUD and origin uniqueness lookups in PostgreSQL.
 * Source exists as an independent entity with optional winery scope (winery_id ON DELETE SET NULL).
 */

const crypto = require('crypto');
const db = require('../../knowledge/db');
const { validateUrlSsrf } = require('./ssrfProtection');

const VALID_SOURCE_TYPES = [
    'official_website',
    'industry_portal',
    'government',
    'contest',
    'media',
    'catalog',
    'other',
];

const VALID_TRUST_LEVELS = ['A', 'B', 'C', 'D'];

function generateSourceId() {
    return `src_${crypto.randomBytes(8).toString('hex')}`;
}

async function createSource({
    name,
    seedUrl,
    sourceType = 'official_website',
    trustLevel = 'C',
    publisher = null,
    wineryId = null,
}, clientOverride = null) {
    if (!name || typeof name !== 'string' || !name.trim()) {
        throw Object.assign(new Error('KOS_SOURCE_NAME_REQUIRED'), { code: 'KOS_SOURCE_NAME_REQUIRED' });
    }

    if (!seedUrl || typeof seedUrl !== 'string') {
        throw Object.assign(new Error('KOS_SOURCE_SEED_URL_REQUIRED'), { code: 'KOS_SOURCE_SEED_URL_REQUIRED' });
    }

    if (!VALID_SOURCE_TYPES.includes(sourceType)) {
        throw Object.assign(new Error(`KOS_SOURCE_TYPE_INVALID: ${sourceType}`), { code: 'KOS_SOURCE_TYPE_INVALID' });
    }

    if (!VALID_TRUST_LEVELS.includes(trustLevel)) {
        throw Object.assign(new Error(`KOS_TRUST_LEVEL_INVALID: ${trustLevel}`), { code: 'KOS_TRUST_LEVEL_INVALID' });
    }

    // SSRF Validation & Normalized Origin extraction
    const ssrfResult = await validateUrlSsrf(seedUrl);
    const normalizedOrigin = ssrfResult.normalizedOrigin;

    const sourceId = generateSourceId();
    const queryClient = clientOverride || (db.isEnabled() ? db.getPool() : null);

    if (queryClient) {
        const sql = `
            INSERT INTO kos_sources (
                id, name, seed_url, normalized_origin, source_type, trust_level, publisher, winery_id, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
            RETURNING *;
        `;
        const params = [sourceId, name.trim(), seedUrl, normalizedOrigin, sourceType, trustLevel, publisher, wineryId];
        const { rows } = await queryClient.query(sql, params);
        return rows[0] || null;
    }

    // Dev / Memory fallback
    return {
        id: sourceId,
        name: name.trim(),
        seed_url: seedUrl,
        normalized_origin: normalizedOrigin,
        source_type: sourceType,
        trust_level: trustLevel,
        publisher,
        winery_id: wineryId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
}

async function getSource(id, clientOverride = null) {
    const queryClient = clientOverride || (db.isEnabled() ? db.getPool() : null);
    if (!queryClient) return null;

    const { rows } = await queryClient.query('SELECT * FROM kos_sources WHERE id = $1', [id]);
    return rows[0] || null;
}

async function findSourceByOrigin(normalizedOrigin, clientOverride = null) {
    const queryClient = clientOverride || (db.isEnabled() ? db.getPool() : null);
    if (!queryClient) return null;

    const { rows } = await queryClient.query('SELECT * FROM kos_sources WHERE normalized_origin = $1', [normalizedOrigin]);
    return rows[0] || null;
}

async function listSources({ wineryId = null, sourceType = null } = {}, clientOverride = null) {
    const queryClient = clientOverride || (db.isEnabled() ? db.getPool() : null);
    if (!queryClient) return [];

    let sql = 'SELECT * FROM kos_sources';
    const conditions = [];
    const params = [];

    if (wineryId) {
        params.push(wineryId);
        conditions.push(`winery_id = $${params.length}`);
    }
    if (sourceType) {
        params.push(sourceType);
        conditions.push(`source_type = $${params.length}`);
    }

    if (conditions.length) {
        sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY created_at DESC';

    const { rows } = await queryClient.query(sql, params);
    return rows;
}

module.exports = {
    createSource,
    getSource,
    findSourceByOrigin,
    listSources,
    VALID_SOURCE_TYPES,
    VALID_TRUST_LEVELS,
};
