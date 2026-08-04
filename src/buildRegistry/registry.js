'use strict';

const LEGACY_BUILD = 'legacy';
const ACTIVE_KEY = 'active_build';
const PREVIOUS_KEY = 'previous_build';

const ERROR = {
    INVALID_ACTIVE_BUILD: 'INVALID_ACTIVE_BUILD',
    INVALID_TARGET: 'INVALID_TARGET',
    BUILD_NOT_FOUND: 'BUILD_NOT_FOUND',
    BUILD_NOT_READY: 'BUILD_NOT_READY',
    BUILD_WRITE: 'BUILD_WRITE',
};

const BUILDS_DDL = `
CREATE TABLE IF NOT EXISTS build_registry_builds (
    build_id            TEXT PRIMARY KEY,
    status              TEXT NOT NULL CHECK (status IN (
                            'building','ready','active','rolled_back',
                            'verification_failed','cancelled')),
    input_fingerprint   TEXT NOT NULL,
    input_snapshot      JSONB NOT NULL,
    source_count        INT  NOT NULL,
    chunk_count         INT  NOT NULL DEFAULT 0,
    embedding_count     INT  NOT NULL DEFAULT 0,
    model               TEXT,
    hooks_version       TEXT,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at         TIMESTAMPTZ,
    created_by          TEXT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

const CHUNKS_DDL = `
CREATE TABLE IF NOT EXISTS build_registry_chunks (
    chunk_id        TEXT NOT NULL,
    build_id        TEXT NOT NULL REFERENCES build_registry_builds(build_id) ON DELETE RESTRICT,
    source_file     TEXT NOT NULL,
    title           TEXT,
    doc_type        TEXT,
    language        TEXT,
    source          TEXT,
    confidence      TEXT,
    entity_id       TEXT,
    winery          TEXT,
    region          TEXT,
    grape           TEXT,
    date            TEXT,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    chunk_index     INT NOT NULL DEFAULT 0,
    text            TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    version_key     TEXT NOT NULL,
    model           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (build_id, chunk_id)
)`;

const STATE_DDL = `
CREATE TABLE IF NOT EXISTS build_registry_state (
    key             TEXT PRIMARY KEY,
    value           TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

const INDEX_DDL = [
    'CREATE INDEX IF NOT EXISTS idx_build_registry_builds_status ON build_registry_builds(status)',
    'CREATE INDEX IF NOT EXISTS idx_build_registry_builds_fingerprint ON build_registry_builds(input_fingerprint)',
    'CREATE INDEX IF NOT EXISTS idx_build_registry_chunks_build ON build_registry_chunks(build_id)',
    'CREATE INDEX IF NOT EXISTS idx_build_registry_chunks_source ON build_registry_chunks(build_id, source_file)',
];

function buildError(code, buildId, detail) {
    const message = detail === undefined
        ? `${code}: ${buildId}`
        : `${code}: ${buildId} (${detail})`;
    const err = new Error(message);
    err.code = code;
    err.build_id = buildId;
    if (detail !== undefined) {
        err.detail = detail;
    }
    return err;
}

function isLegacy(buildId) {
    return buildId === LEGACY_BUILD;
}

async function initSchema(pool) {
    const statements = [BUILDS_DDL, CHUNKS_DDL, STATE_DDL, ...INDEX_DDL];
    for (const statement of statements) {
        await pool.query(statement);
    }
    await pool.query(
        'INSERT INTO build_registry_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
        [ACTIVE_KEY, LEGACY_BUILD]
    );
    await pool.query(
        'INSERT INTO build_registry_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
        [PREVIOUS_KEY, LEGACY_BUILD]
    );
    try {
        await pool.query('ALTER TABLE build_registry_chunks ADD COLUMN IF NOT EXISTS embedding vector(768)');
        await pool.query(
            'CREATE INDEX IF NOT EXISTS idx_build_registry_chunks_vector ON build_registry_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)'
        );
    } catch (err) {
        return false;
    }
    return true;
}

async function resolveActiveBuild(pool) {
    const { rows } = await pool.query('SELECT value FROM build_registry_state WHERE key = $1', [ACTIVE_KEY]);
    const value = rows.length ? rows[0].value : LEGACY_BUILD;
    if (isLegacy(value)) {
        return { build_id: LEGACY_BUILD };
    }
    const { rows: builds } = await pool.query(
        'SELECT status FROM build_registry_builds WHERE build_id = $1',
        [value]
    );
    if (builds.length === 0 || builds[0].status !== 'active') {
        return { error: ERROR.INVALID_ACTIVE_BUILD, build_id: value };
    }
    return { build_id: value };
}

async function activateBuild(pool, buildId) {
    if (!buildId || typeof buildId !== 'string' || isLegacy(buildId)) {
        throw buildError(ERROR.INVALID_TARGET, buildId);
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            'SELECT value FROM build_registry_state WHERE key IN ($1, $2) FOR UPDATE',
            [ACTIVE_KEY, PREVIOUS_KEY]
        );
        const target = await client.query(
            'SELECT status FROM build_registry_builds WHERE build_id = $1 FOR UPDATE',
            [buildId]
        );
        if (target.rows.length === 0) {
            throw buildError(ERROR.BUILD_NOT_FOUND, buildId);
        }
        if (target.rows[0].status !== 'ready') {
            throw buildError(ERROR.BUILD_NOT_READY, buildId, `status=${target.rows[0].status}`);
        }
        const activeRow = await client.query('SELECT value FROM build_registry_state WHERE key = $1', [ACTIVE_KEY]);
        const previousBuild = activeRow.rows.length ? activeRow.rows[0].value : LEGACY_BUILD;
        if (!isLegacy(previousBuild)) {
            await client.query(
                'UPDATE build_registry_builds SET status = $1, updated_at = NOW() WHERE build_id = $2',
                ['ready', previousBuild]
            );
        }
        await client.query(
            'UPDATE build_registry_state SET value = $1, updated_at = NOW() WHERE key = $2',
            [previousBuild, PREVIOUS_KEY]
        );
        await client.query(
            'UPDATE build_registry_state SET value = $1, updated_at = NOW() WHERE key = $2',
            [buildId, ACTIVE_KEY]
        );
        await client.query(
            'UPDATE build_registry_builds SET status = $1, updated_at = NOW() WHERE build_id = $2',
            ['active', buildId]
        );
        await client.query('COMMIT');
        return { build_id: buildId, previous_build: previousBuild };
    } catch (err) {
        await safeRollback(client);
        throw err;
    } finally {
        client.release();
    }
}

async function rollbackBuild(pool) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            'SELECT value FROM build_registry_state WHERE key IN ($1, $2) FOR UPDATE',
            [ACTIVE_KEY, PREVIOUS_KEY]
        );
        const activeRow = await client.query('SELECT value FROM build_registry_state WHERE key = $1', [ACTIVE_KEY]);
        const currentBuild = activeRow.rows.length ? activeRow.rows[0].value : LEGACY_BUILD;
        if (isLegacy(currentBuild)) {
            await client.query('COMMIT');
            return { build_id: LEGACY_BUILD, rolled_back: LEGACY_BUILD };
        }
        const prevRow = await client.query('SELECT value FROM build_registry_state WHERE key = $1', [PREVIOUS_KEY]);
        const previousBuild = prevRow.rows.length ? prevRow.rows[0].value : LEGACY_BUILD;
        await client.query(
            'UPDATE build_registry_builds SET status = $1, updated_at = NOW() WHERE build_id = $2',
            ['rolled_back', currentBuild]
        );
        await client.query(
            'UPDATE build_registry_state SET value = $1, updated_at = NOW() WHERE key = $2',
            [previousBuild, ACTIVE_KEY]
        );
        if (!isLegacy(previousBuild)) {
            await client.query(
                'UPDATE build_registry_builds SET status = $1, updated_at = NOW() WHERE build_id = $2',
                ['active', previousBuild]
            );
        }
        await client.query('DELETE FROM build_registry_state WHERE key = $1', [PREVIOUS_KEY]);
        await client.query('COMMIT');
        return { build_id: previousBuild, rolled_back: currentBuild };
    } catch (err) {
        await safeRollback(client);
        throw err;
    } finally {
        client.release();
    }
}

function safeRollback(client) {
    return client.query('ROLLBACK').catch(() => {});
}

function getPool() {
    const db = require('../knowledge/db');
    return db.getPool();
}

module.exports = {
    LEGACY_BUILD,
    ACTIVE_KEY,
    PREVIOUS_KEY,
    ERROR,
    initSchema,
    resolveActiveBuild,
    activateBuild,
    rollbackBuild,
    getPool,
};