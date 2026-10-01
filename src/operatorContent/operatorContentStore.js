'use strict';

// Persistence for operator-controlled content (Dashboard → Рекомендации /
// Новинки). One row per block; the row keeps the operator's raw text AND the
// structured representation built from it at save time (parsed promotions /
// news items with resolution status). Runtime only ever reads `parsed`.
//
// Schema (created lazily, like the other runtime tables):
//   operator_content(id PK 'recommendations'|'news', type, raw_text, enabled,
//     mode, active_from, active_until, settings JSONB, parsed JSONB,
//     version, created_at, updated_at, updated_by)
// Rollback: DROP TABLE operator_content; (nothing else references it).

const TYPES = Object.freeze(['recommendations', 'news']);

function isPostgresUrl(value) {
    return /^postgres(ql)?:\/\//i.test(String(value || ''));
}

function rowToBlock(row) {
    if (!row) return null;
    return {
        id: row.id,
        type: row.type,
        rawText: row.raw_text || '',
        enabled: row.enabled === true,
        mode: row.mode || 'off',
        activeFrom: row.active_from ? new Date(row.active_from).toISOString() : null,
        activeUntil: row.active_until ? new Date(row.active_until).toISOString() : null,
        settings: row.settings || {},
        parsed: row.parsed || {},
        version: Number(row.version) || 0,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
        updatedBy: row.updated_by || null,
    };
}

function createPostgresOperatorContentStore(poolProvider = () => require('../knowledge/db').getPool()) {
    let ready = null;
    const pool = () => poolProvider();
    function init() {
        if (!ready) {
            ready = pool().query(`
                CREATE TABLE IF NOT EXISTS operator_content (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    raw_text TEXT NOT NULL DEFAULT '',
                    enabled BOOLEAN NOT NULL DEFAULT FALSE,
                    mode TEXT NOT NULL DEFAULT 'off',
                    active_from TIMESTAMPTZ,
                    active_until TIMESTAMPTZ,
                    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
                    parsed JSONB NOT NULL DEFAULT '{}'::jsonb,
                    version INT NOT NULL DEFAULT 0,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_by TEXT
                );
            `).catch((error) => { ready = null; throw error; });
        }
        return ready;
    }
    return {
        backend: 'postgres',
        async get(id) {
            await init();
            const { rows } = await pool().query('SELECT * FROM operator_content WHERE id = $1', [id]);
            return rowToBlock(rows[0]);
        },
        async save(block) {
            await init();
            const { rows } = await pool().query(
                `INSERT INTO operator_content (id, type, raw_text, enabled, mode, active_from, active_until, settings, parsed, version, updated_at, updated_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,NOW(),$10)
                 ON CONFLICT (id) DO UPDATE SET raw_text = EXCLUDED.raw_text, enabled = EXCLUDED.enabled, mode = EXCLUDED.mode,
                   active_from = EXCLUDED.active_from, active_until = EXCLUDED.active_until, settings = EXCLUDED.settings,
                   parsed = EXCLUDED.parsed, version = operator_content.version + 1, updated_at = NOW(), updated_by = EXCLUDED.updated_by
                 RETURNING *`,
                [block.id, block.type, block.rawText, block.enabled, block.mode, block.activeFrom, block.activeUntil,
                    JSON.stringify(block.settings || {}), JSON.stringify(block.parsed || {}), block.updatedBy || null]
            );
            return rowToBlock(rows[0]);
        },
    };
}

function createMemoryOperatorContentStore() {
    const rows = new Map();
    return {
        backend: 'memory',
        async get(id) { return rows.has(id) ? JSON.parse(JSON.stringify(rows.get(id))) : null; },
        async save(block) {
            const now = new Date().toISOString();
            const prev = rows.get(block.id);
            const next = { ...block, version: (prev ? prev.version : 0) + 1, createdAt: prev ? prev.createdAt : now, updatedAt: now };
            rows.set(block.id, JSON.parse(JSON.stringify(next)));
            return JSON.parse(JSON.stringify(next));
        },
    };
}

let store = null;
function getOperatorContentStore() {
    if (!store) store = isPostgresUrl(process.env.DATABASE_URL) ? createPostgresOperatorContentStore() : createMemoryOperatorContentStore();
    return store;
}
function setOperatorContentStoreForTests(s) { store = s; }

module.exports = { TYPES, rowToBlock, createPostgresOperatorContentStore, createMemoryOperatorContentStore, getOperatorContentStore, setOperatorContentStoreForTests };
