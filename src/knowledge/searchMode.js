'use strict';

// Runtime-toggleable knowledge search mode — flipped live from the
// Dashboard rather than an env var requiring a redeploy. 'disabled' is a
// master kill switch (search() short-circuits to zero hits without even
// touching the index) added specifically so the assistant's behavior with
// NO knowledge base access at all can be verified directly, not just
// inferred from bad answers.
//
// Persisted to Postgres (app_settings table) because this project
// redeploys via `railway up`, which replaces the whole running container
// — an in-memory-only setting silently reverts to the default on every
// deploy, which defeated the point of this being a Dashboard toggle in
// the first place (confirmed happening in practice: hybrid mode kept
// resetting to keyword after routine deploys). Falls back to in-memory
// only if Postgres is unavailable — same best-effort pattern as the rest
// of src/knowledge/*.
const VALID_MODES = ['keyword', 'hybrid', 'disabled'];
const VALID_MODES_SET = new Set(VALID_MODES);
const SETTINGS_KEY = 'knowledge_search_mode';
const DEFAULT_MODE = 'hybrid';

let currentMode = DEFAULT_MODE;

function getMode() {
    return currentMode;
}

function setMode(mode) {
    if (!VALID_MODES_SET.has(mode)) {
        const error = new Error(`invalid_search_mode: ${mode}`);
        error.code = 'invalid_search_mode';
        throw error;
    }
    currentMode = mode;
    persistMode(mode).catch((err) => {
        console.error('[searchMode] failed to persist mode to Postgres (in-memory value still applied, but will revert to default on next deploy):', err.message);
    });
    return currentMode;
}

async function persistMode(mode) {
    const db = require('./db');
    if (!db.isEnabled()) return;
    const pool = await db.init();
    if (!pool) return;
    await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();`,
        [SETTINGS_KEY, mode]
    );
}

// Called once at server boot (see src/server.js) to restore whatever mode
// was last set via the Dashboard, instead of always starting from
// DEFAULT_MODE after every deploy.
async function loadPersistedMode() {
    try {
        const db = require('./db');
        if (!db.isEnabled()) return currentMode;
        const pool = await db.init();
        if (!pool) return currentMode;
        const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [SETTINGS_KEY]);
        if (rows.length > 0 && VALID_MODES_SET.has(rows[0].value)) {
            currentMode = rows[0].value;
        }
    } catch (err) {
        console.error('[searchMode] failed to load persisted mode from Postgres (using default):', err.message);
    }
    return currentMode;
}

module.exports = { getMode, setMode, loadPersistedMode, VALID_MODES, DEFAULT_MODE };
