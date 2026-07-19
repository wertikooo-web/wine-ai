'use strict';

// Persistent persona overrides (name/description/welcome message/system
// prompt) editable from the Settings tab. Postgres-backed when DATABASE_URL
// is set (Railway — survives redeploys, unlike local disk in that
// environment), file-backed fallback for local dev — same dual-mode
// pattern as src/knowledge/discovered/store.js. Reuses the existing pg pool
// helper at src/knowledge/db.js (a generic connection helper despite its
// location; not knowledge-specific in implementation).
const fs = require('fs');
const path = require('path');
const db = require('../knowledge/db');

const FILE_PATH = path.resolve(__dirname, '..', '..', 'data', 'persona-overrides.json');
const FIELDS = ['name', 'description', 'welcome_message', 'system_prompt'];
const MAX_CHARS = { name: 80, description: 400, welcome_message: 600, system_prompt: 24000 };

// In-memory cache, synchronously readable — the realtime prompt-assembly
// code (src/realtime/realtimePrompt.js) calls defaultPersonaPrompt()
// synchronously during session setup, so overrides must be readable
// without an await there. load() populates this once at boot; save()
// updates it immediately in the same tick as the write.
let cache = {};

function sanitize(partial) {
    const next = {};
    for (const field of FIELDS) {
        if (typeof partial[field] !== 'string') continue;
        const trimmed = partial[field].trim().slice(0, MAX_CHARS[field]);
        if (trimmed) next[field] = trimmed;
    }
    return next;
}

async function ensureTable(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS persona_overrides (
            id INT PRIMARY KEY DEFAULT 1,
            name TEXT,
            description TEXT,
            welcome_message TEXT,
            system_prompt TEXT,
            updated_at TIMESTAMPTZ
        );
    `);
}

async function load() {
    if (db.isEnabled()) {
        const pool = db.getPool();
        await ensureTable(pool);
        const { rows } = await pool.query('SELECT * FROM persona_overrides WHERE id = 1');
        cache = rows[0] ? sanitize({
            name: rows[0].name || '',
            description: rows[0].description || '',
            welcome_message: rows[0].welcome_message || '',
            system_prompt: rows[0].system_prompt || '',
        }) : {};
        return cache;
    }
    try {
        if (fs.existsSync(FILE_PATH)) {
            cache = sanitize(JSON.parse(fs.readFileSync(FILE_PATH, 'utf8')) || {});
        }
    } catch {
        cache = {};
    }
    return cache;
}

// `partial[field] === ''` (explicit empty string) clears that field back to
// the built-in default; omitting a field leaves its current override (or
// lack of one) untouched.
async function save(partial) {
    const merged = { ...cache };
    for (const field of FIELDS) {
        if (typeof partial[field] !== 'string') continue;
        const trimmed = partial[field].trim();
        if (trimmed === '') delete merged[field];
        else merged[field] = trimmed.slice(0, MAX_CHARS[field]);
    }
    cache = merged;

    if (db.isEnabled()) {
        const pool = db.getPool();
        await ensureTable(pool);
        await pool.query(
            `INSERT INTO persona_overrides (id, name, description, welcome_message, system_prompt, updated_at)
             VALUES (1, $1, $2, $3, $4, $5)
             ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name, description = EXCLUDED.description,
                welcome_message = EXCLUDED.welcome_message, system_prompt = EXCLUDED.system_prompt,
                updated_at = EXCLUDED.updated_at`,
            [merged.name || null, merged.description || null, merged.welcome_message || null, merged.system_prompt || null, new Date().toISOString()],
        );
    } else {
        fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
        fs.writeFileSync(FILE_PATH, JSON.stringify(merged, null, 2), 'utf8');
    }
    return merged;
}

function getCached() {
    return cache;
}

module.exports = { load, save, getCached, FIELDS, MAX_CHARS };
