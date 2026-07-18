'use strict';

// File-backed OR Postgres-backed queue for crawled documents — schema
// matches docs/KNOWLEDGE_PIPELINE_ARCHITECTURE.md §13.4. Every function is
// async regardless of backend (even the file path, which doesn't strictly
// need to be) so callers never have to special-case which storage is
// active — that decision lives only here, behind `db.isEnabled()`.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');

const DEFAULT_DIR = path.resolve(__dirname, '..', '..', '..', 'knowledge', 'discovered');

function idFor(url) {
    return 'doc_' + crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
}

// ---- file backend (used when DATABASE_URL is not set — local dev) ----

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function docPath(dir, id) {
    return path.join(dir, `${id}.json`);
}

function fileLoadAll(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function fileFindByUrl(url, dir) {
    const filePath = docPath(dir, idFor(url));
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
}

function fileFindByContentHash(contentHash, dir) {
    return fileLoadAll(dir).find((doc) => doc.contentHash === contentHash) || null;
}

function fileSave(doc, dir) {
    ensureDir(dir);
    const id = doc.id || idFor(doc.url);
    const record = { ...doc, id };
    fs.writeFileSync(docPath(dir, id), JSON.stringify(record, null, 2), 'utf8');
    return record;
}

function fileSetStatus(id, status, dir) {
    const filePath = docPath(dir, id);
    if (!fs.existsSync(filePath)) return null;
    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    doc.status = status;
    doc.lastVerifiedAt = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8');
    return doc;
}

// ---- row <-> doc mapping (Postgres backend) ----

function rowToDoc(row) {
    if (!row) return null;
    return {
        id: row.id,
        title: row.title,
        url: row.url,
        publisher: row.publisher,
        publishedAt: row.published_at,
        fetchedAt: row.fetched_at,
        language: row.language,
        sourceId: row.source_id,
        trustLevel: row.trust_level,
        contentHash: row.content_hash,
        topics: row.topics || [],
        entities: row.entities || { wineries: [], wines: [], grapes: [], regions: [] },
        summary: row.summary,
        status: row.status,
        text: row.text,
        lastVerifiedAt: row.last_verified_at,
    };
}

// ---- public API (always async) ----

async function loadAll(dir = DEFAULT_DIR) {
    if (db.isEnabled()) {
        const pool = await db.init();
        const { rows } = await pool.query('SELECT * FROM knowledge_documents ORDER BY fetched_at DESC');
        return rows.map(rowToDoc);
    }
    return fileLoadAll(dir);
}

async function findByUrl(url, dir = DEFAULT_DIR) {
    if (db.isEnabled()) {
        const pool = await db.init();
        const { rows } = await pool.query('SELECT * FROM knowledge_documents WHERE url = $1', [url]);
        return rowToDoc(rows[0]);
    }
    return fileFindByUrl(url, dir);
}

async function findByContentHash(contentHash, dir = DEFAULT_DIR) {
    if (db.isEnabled()) {
        const pool = await db.init();
        const { rows } = await pool.query('SELECT * FROM knowledge_documents WHERE content_hash = $1 LIMIT 1', [contentHash]);
        return rowToDoc(rows[0]);
    }
    return fileFindByContentHash(contentHash, dir);
}

// `status`: 'pending' | 'approved' | 'rejected'. Trust-A documents are
// auto-approved at write time by the caller (scripts/knowledge-update.js),
// never inside the store itself — the store just persists whatever status
// it's given, so the auto-approve *policy* stays visible in one place.
async function save(doc, dir = DEFAULT_DIR) {
    const id = doc.id || idFor(doc.url);
    const record = { ...doc, id };
    if (db.isEnabled()) {
        const pool = await db.init();
        await pool.query(
            `INSERT INTO knowledge_documents
                (id, title, url, publisher, published_at, fetched_at, language, source_id, trust_level, content_hash, topics, entities, summary, status, text, last_verified_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
             ON CONFLICT (id) DO UPDATE SET
                title = EXCLUDED.title, url = EXCLUDED.url, publisher = EXCLUDED.publisher,
                published_at = EXCLUDED.published_at, fetched_at = EXCLUDED.fetched_at,
                language = EXCLUDED.language, source_id = EXCLUDED.source_id, trust_level = EXCLUDED.trust_level,
                content_hash = EXCLUDED.content_hash, topics = EXCLUDED.topics, entities = EXCLUDED.entities,
                summary = EXCLUDED.summary, status = EXCLUDED.status, text = EXCLUDED.text,
                last_verified_at = EXCLUDED.last_verified_at`,
            [
                record.id, record.title, record.url, record.publisher, record.publishedAt, record.fetchedAt,
                record.language, record.sourceId, record.trustLevel, record.contentHash,
                JSON.stringify(record.topics || []), JSON.stringify(record.entities || {}),
                record.summary, record.status, record.text, record.lastVerifiedAt,
            ],
        );
        return record;
    }
    return fileSave(record, dir);
}

async function setStatus(id, status, dir = DEFAULT_DIR) {
    if (db.isEnabled()) {
        const pool = await db.init();
        const lastVerifiedAt = new Date().toISOString();
        const { rows } = await pool.query(
            'UPDATE knowledge_documents SET status = $1, last_verified_at = $2 WHERE id = $3 RETURNING *',
            [status, lastVerifiedAt, id],
        );
        return rowToDoc(rows[0]);
    }
    return fileSetStatus(id, status, dir);
}

module.exports = { DEFAULT_DIR, idFor, loadAll, findByUrl, findByContentHash, save, setStatus };
