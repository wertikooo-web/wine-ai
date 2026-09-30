'use strict';

// Rendered bridge phrases, persisted so a deploy does not depend on TTS.
//
// Production 30 Sep: after three deploys in half an hour the new process
// rendered none of the 9 phrases (TTS rate limit, most likely), so no
// "Минуточку…" played at all. Audio that rendered once is stored in the
// existing Postgres app_settings table and loaded by every later process;
// TTS is only called for phrases that were never rendered.
//
// Key: bridge_phrase:<voice>:<lang>:<index>:<text hash> -- editing a phrase
// changes the hash, so the old audio is never played for new text.
// Best effort: any storage error is logged and the cache falls back to TTS.

const crypto = require('crypto');

const KEY_PREFIX = 'bridge_phrase:';

function phraseKey(voice, lang, index, text) {
    const hash = crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 12);
    return `${KEY_PREFIX}${voice}:${lang}:${index}:${hash}`;
}

function isPostgresUrl(value) {
    return /^postgres(ql)?:\/\//i.test(String(value || ''));
}

// Postgres-backed store (app_settings). null when there is no real database
// (local runs, tests with DATABASE_URL=memory).
function createPostgresBridgePhraseStore({ env = process.env, log = () => {} } = {}) {
    if (!isPostgresUrl(env.DATABASE_URL)) return null;
    async function pool() {
        const db = require('../knowledge/db');
        return db.init();
    }
    return {
        async load(voice) {
            const p = await pool();
            if (!p) return new Map();
            const { rows } = await p.query('SELECT key, value FROM app_settings WHERE key LIKE $1', [`${KEY_PREFIX}${voice}:%`]);
            const entries = new Map();
            for (const row of rows) {
                try {
                    const value = JSON.parse(row.value);
                    if (value && value.audioBase64) entries.set(row.key, { audioBase64: value.audioBase64, sampleRate: value.sampleRate || 24000 });
                } catch (error) {
                    log('bridge_phrase_store_bad_row', { key: row.key });
                }
            }
            return entries;
        },
        async save(key, entry) {
            const p = await pool();
            if (!p) return;
            await p.query(
                `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();`,
                [key, JSON.stringify({ audioBase64: entry.audioBase64, sampleRate: entry.sampleRate || 24000 })]
            );
        },
    };
}

module.exports = { phraseKey, isPostgresUrl, createPostgresBridgePhraseStore, KEY_PREFIX };
