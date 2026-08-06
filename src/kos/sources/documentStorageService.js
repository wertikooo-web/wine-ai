'use strict';

const db = require('../../knowledge/db');
const objectStorage = require('../storage/objectStorage');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function clampInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function safePublicUrl(value) {
    if (!value) return null;
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
    } catch {
        return null;
    }
}

async function listDocuments({ sourceId = '', limit = DEFAULT_LIMIT, offset = 0 } = {}, dependencies = {}) {
    const queryClient = dependencies.queryClient || (db.isEnabled() ? db.getPool() : null);
    const storage = dependencies.objectStorage || objectStorage;
    if (!queryClient) {
        const error = new Error('KOS document storage requires PostgreSQL');
        error.code = 'KOS_DOCUMENT_STORAGE_UNAVAILABLE';
        error.statusCode = 503;
        throw error;
    }

    const safeLimit = clampInteger(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const safeOffset = clampInteger(offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const cleanSourceId = typeof sourceId === 'string' ? sourceId.trim() : '';
    const whereSql = cleanSourceId ? 'WHERE d.source_id = $1' : '';
    const values = cleanSourceId ? [cleanSourceId] : [];

    const countResult = await queryClient.query(
        `SELECT COUNT(*) AS count FROM kos_source_documents d ${whereSql}`,
        values
    );
    const total = Number.parseInt(countResult.rows?.[0]?.count, 10) || 0;

    const limitPosition = values.length + 1;
    const offsetPosition = values.length + 2;
    const result = await queryClient.query(`
        SELECT
            d.id,
            d.source_id,
            d.requested_url,
            d.canonical_url,
            d.content_type,
            d.content_length,
            d.created_at AS document_created_at,
            d.updated_at AS document_updated_at,
            s.name AS source_name,
            s.source_type,
            s.seed_url,
            latest.id AS version_id,
            latest.storage_key,
            latest.size_bytes,
            latest.declared_mime_type,
            latest.detected_mime_type,
            latest.fetched_at,
            latest.checksum_sha256
        FROM kos_source_documents d
        JOIN kos_sources s ON s.id = d.source_id
        LEFT JOIN LATERAL (
            SELECT v.*
            FROM kos_source_document_versions v
            WHERE v.document_id = d.id
            ORDER BY v.fetched_at DESC, v.created_at DESC
            LIMIT 1
        ) latest ON TRUE
        ${whereSql}
        ORDER BY COALESCE(latest.fetched_at, d.updated_at, d.created_at) DESC, d.id ASC
        LIMIT $${limitPosition} OFFSET $${offsetPosition}
    `, [...values, safeLimit, safeOffset]);

    let storedKeys = new Set();
    let storageCheckError = null;
    try {
        const objects = await storage.list('raw/');
        storedKeys = new Set((objects || []).map((item) => typeof item === 'string' ? item : item.key).filter(Boolean));
    } catch (error) {
        storageCheckError = error.message || 'Object storage check failed';
    }

    const documents = (result.rows || []).map((row) => {
        const hasVersion = Boolean(row.version_id && row.storage_key);
        const objectExists = storageCheckError ? null : (hasVersion ? storedKeys.has(row.storage_key) : false);
        const storageStatus = !hasVersion
            ? 'awaiting_file'
            : (objectExists === null ? 'unknown' : (objectExists ? 'available' : 'missing'));

        return {
            id: row.id,
            source: {
                id: row.source_id,
                name: row.source_name,
                type: row.source_type,
                seedUrl: safePublicUrl(row.seed_url),
            },
            url: safePublicUrl(row.canonical_url) || safePublicUrl(row.requested_url),
            requestedUrl: safePublicUrl(row.requested_url),
            storageStatus,
            objectExists,
            fetchedAt: row.fetched_at || null,
            sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
            mimeType: row.detected_mime_type || row.declared_mime_type || row.content_type || null,
            checksumSha256: row.checksum_sha256 || null,
            versionId: row.version_id || null,
        };
    });

    return {
        ok: true,
        documents,
        pagination: {
            total,
            limit: safeLimit,
            offset: safeOffset,
            hasMore: safeOffset + documents.length < total,
        },
        storageCheck: {
            ok: !storageCheckError,
            error: storageCheckError,
        },
    };
}

module.exports = { listDocuments, safePublicUrl, DEFAULT_LIMIT, MAX_LIMIT };
