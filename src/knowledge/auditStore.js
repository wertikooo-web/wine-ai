'use strict';

// Answer Audit case store (Phase 2).
//
// Persists each audit run plus the human review verdict/comment so the DoD
// loop works end-to-end:
//   - every /api/knowledge/audit call creates one case (review_status=new),
//   - an admin opens the case, reads claims/provenance, and sets
//     review_status (ok|needs_review|defect) with an optional comment,
//   - the benchmark can later score cases by their review labels.
//
// Backends: PostgreSQL when DATABASE_URL is present (railway UP), otherwise
// a JSON file per case under knowledge/audit/ (local dev / tests). All
// functions are async regardless of backend so callers never branch.

const fs = require('fs');
const path = require('path');
const db = require('./db');

const AUDIT_DIR = path.resolve(__dirname, '..', '..', 'knowledge', 'audit');
const REVIEW_STATUSES = new Set(['new', 'ok', 'needs_review', 'defect']);

function casePath(id) {
    return path.join(AUDIT_DIR, `${id}.json`);
}

function ensureFileDir() {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
}

function fileSave(record) {
    ensureFileDir();
    fs.writeFileSync(casePath(record.id), JSON.stringify(record, null, 2), 'utf8');
    return record;
}

function fileFind(id) {
    const file = casePath(id);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function fileList(status) {
    if (!fs.existsSync(AUDIT_DIR)) return [];
    return fs.readdirSync(AUDIT_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(AUDIT_DIR, f), 'utf8')))
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
        .filter((record) => filterByStatus(record, status));
}

function filterByStatus(record, status) {
    if (!status || status === 'all') return true;
    return String(record.review_status || 'new') === String(status);
}

async function ensurePgSchema(pool) {
    const p = pool || db.getPool();
    await p.query(`
        CREATE TABLE IF NOT EXISTS answer_audit_cases (
            id TEXT PRIMARY KEY,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            question TEXT NOT NULL,
            language TEXT,
            answer_mode TEXT NOT NULL,
            constraints JSONB NOT NULL DEFAULT '[]'::jsonb,
            results JSONB NOT NULL,
            latency_ms_total NUMERIC,
            review_status TEXT NOT NULL DEFAULT 'new',
            review_comment TEXT,
            reviewed_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await p.query('CREATE INDEX IF NOT EXISTS idx_answer_audit_cases_created ON answer_audit_cases(created_at DESC)');
    await p.query('CREATE INDEX IF NOT EXISTS idx_answer_audit_cases_status ON answer_audit_cases(review_status)');
}

function rowToRecord(row) {
    return {
        id: row.id,
        created_at: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
        question: row.question,
        language: row.language,
        answer_mode: row.answer_mode,
        constraints: row.constraints || [],
        results: row.results,
        latency_ms_total: row.latency_ms_total != null ? Number(row.latency_ms_total) : null,
        review_status: row.review_status,
        review_comment: row.review_comment,
        reviewed_at: row.reviewed_at ? (row.reviewed_at.toISOString ? row.reviewed_at.toISOString() : row.reviewed_at) : null,
        updated_at: row.updated_at ? (row.updated_at.toISOString ? row.updated_at.toISOString() : row.updated_at) : null,
    };
}

async function pgSave(pool, record) {
    await db.init();
    const p = pool || db.getPool();
    await p.query(
        `INSERT INTO answer_audit_cases
            (id, created_at, question, language, answer_mode, constraints, results, latency_ms_total, review_status, review_comment, reviewed_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
         ON CONFLICT (id) DO UPDATE SET
            answer_mode = EXCLUDED.answer_mode,
            constraints = EXCLUDED.constraints,
            results = EXCLUDED.results,
            latency_ms_total = EXCLUDED.latency_ms_total,
            review_comment = COALESCE(EXCLUDED.review_comment, answer_audit_cases.review_comment),
            updated_at = NOW()`,
        [
            record.id, record.created_at, record.question, record.language, record.answer_mode,
            JSON.stringify(record.constraints || []), JSON.stringify(record.results || []),
            record.latency_ms_total != null ? Number(record.latency_ms_total) : null,
            record.review_status || 'new', record.review_comment || null, record.reviewed_at || null,
        ],
    );
    return record;
}

async function pgFind(pool, id) {
    await db.init();
    const p = pool || db.getPool();
    const { rows } = await p.query('SELECT * FROM answer_audit_cases WHERE id = $1', [id]);
    return rows.length ? rowToRecord(rows[0]) : null;
}

async function pgList(pool, { limit = 50, status } = {}) {
    await db.init();
    const p = pool || db.getPool();
    const params = [Math.max(1, Math.min(500, Number(limit) || 50))];
    let where = '';
    if (status && status !== 'all' && REVIEW_STATUSES.has(status)) {
        params.unshift(status);
        where = 'WHERE review_status = $1 ';
    }
    const { rows } = await p.query(
        `SELECT * FROM answer_audit_cases ${where}ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
    );
    return rows.map(rowToRecord);
}

async function pgSetReview(pool, id, { status, comment }) {
    await db.init();
    const p = pool || db.getPool();
    const { rows } = await p.query(
        `UPDATE answer_audit_cases
         SET review_status = $2, review_comment = $3, reviewed_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [id, status, comment || null],
    );
    return rows.length ? rowToRecord(rows[0]) : null;
}

// ---- public API (always async) ----

async function save(record, { pool } = {}) {
    const normalized = {
        ...record,
        review_status: REVIEW_STATUSES.has(record?.review_status) ? record.review_status : 'new',
        review_comment: record?.review_comment || null,
    };
    if (db.isEnabled() && !process.env.AUDIT_STORE_FORCE_FILE) {
        try {
            await ensurePgSchema(pool);
            return await pgSave(pool, normalized);
        } catch (error) {
            console.warn('[answerAudit] pg save failed, falling back to file: %s', error.message);
        }
    }
    return fileSave(normalized);
}

async function findById(id, { pool } = {}) {
    if (db.isEnabled() && !process.env.AUDIT_STORE_FORCE_FILE) {
        try {
            await ensurePgSchema(pool);
            const record = await pgFind(pool, id);
            if (record) return record;
        } catch (error) {
            console.warn('[answerAudit] pg find failed, falling back to file:', error?.message);
        }
    }
    return fileFind(id);
}

async function listCases({ limit = 50, status, pool } = {}) {
    const fieldStatus = status && REVIEW_STATUSES.has(status) ? status : null;
    if (db.isEnabled() && !process.env.AUDIT_STORE_FORCE_FILE) {
        try {
            await ensurePgSchema(pool);
            return await pgList(pool, { limit, status: fieldStatus });
        } catch (error) {
            console.warn('[answerAudit] pg list failed, falling back to file:', error?.message);
        }
    }
    const cases = fileList(fieldStatus);
    return cases.slice(0, Math.max(1, Math.min(500, Number(limit) || 50)));
}

async function setReview(id, { status, comment }, { pool } = {}) {
    const normalizedStatus = REVIEW_STATUSES.has(status) ? status : 'new';
    if (db.isEnabled() && !process.env.AUDIT_STORE_FORCE_FILE) {
        try {
            await ensurePgSchema(pool);
            const updated = await pgSetReview(id, normalizedStatus, comment);
            if (updated) return updated;
        } catch (error) {
            console.warn('[answerAudit] pg review failed, falling back to file:', error?.message);
        }
    }
    const record = fileFind(id);
    if (!record) return null;
    record.review_status = normalizedStatus;
    record.review_comment = comment || null;
    record.reviewed_at = new Date().toISOString();
    record.updated_at = new Date().toISOString();
    return fileSave(record);
}

module.exports = {
    save,
    findById,
    listCases,
    setReview,
    REVIEW_STATUSES,
    AUDIT_DIR,
};