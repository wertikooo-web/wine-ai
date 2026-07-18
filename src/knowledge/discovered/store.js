'use strict';

// File-backed queue for crawled documents — schema-compatible with the
// Postgres `documents`/`news` tables + Qdrant payload described in
// docs/KNOWLEDGE_PIPELINE_ARCHITECTURE.md §13.4, so swapping in a real
// database later is a storage-layer change, not a data-model rewrite.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DIR = path.resolve(__dirname, '..', '..', '..', 'knowledge', 'discovered');

function idFor(url) {
    return 'doc_' + crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function docPath(dir, id) {
    return path.join(dir, `${id}.json`);
}

function loadAll(dir = DEFAULT_DIR) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function findByUrl(url, dir = DEFAULT_DIR) {
    const id = idFor(url);
    const filePath = docPath(dir, id);
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
}

function findByContentHash(contentHash, dir = DEFAULT_DIR) {
    return loadAll(dir).find((doc) => doc.contentHash === contentHash) || null;
}

// `status`: 'pending' | 'approved' | 'rejected'. Trust-A documents are
// auto-approved at write time by the caller (scripts/knowledge-update.js),
// never inside the store itself — the store just persists whatever status
// it's given, so the auto-approve *policy* stays visible in one place.
function save(doc, dir = DEFAULT_DIR) {
    ensureDir(dir);
    const id = doc.id || idFor(doc.url);
    const record = { ...doc, id };
    fs.writeFileSync(docPath(dir, id), JSON.stringify(record, null, 2), 'utf8');
    return record;
}

function setStatus(id, status, dir = DEFAULT_DIR) {
    const filePath = docPath(dir, id);
    if (!fs.existsSync(filePath)) return null;
    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    doc.status = status;
    doc.lastVerifiedAt = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8');
    return doc;
}

module.exports = { DEFAULT_DIR, idFor, loadAll, findByUrl, findByContentHash, save, setStatus };
