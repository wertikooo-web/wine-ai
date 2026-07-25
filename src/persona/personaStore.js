'use strict';

// Persistent persona profiles and overrides (name/description/welcome message/system
// prompt/personalityPrompt/mood/style/sommelierGender) editable from the settings dashboard.
// Postgres-backed when DATABASE_URL is set, file-backed fallback for local dev.
const fs = require('fs');
const path = require('path');
const db = require('../knowledge/db');

const FILE_PATH = process.env.PERSONA_OVERRIDES_FILE || path.resolve(__dirname, '..', '..', 'data', 'persona-overrides.json');
const ALLOWED_GENDERS = ['male', 'female'];
const DEFAULT_SOMMELIER_GENDER = 'male';

// In-memory cache, synchronously readable.
// As resolved profile values are constructed synchronously during session setup,
// overrides must be readable without an await here.
let cache = {
    baseProfileId: 'classic',
    mood: 'calm',
    overrides: {},
    name: '',
    description: '',
    welcome_message: '',
    system_prompt: '',
    sommelierGender: DEFAULT_SOMMELIER_GENDER,
    personalityPrompt: ''
};

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
    await pool.query('ALTER TABLE persona_overrides ADD COLUMN IF NOT EXISTS sommelier_gender TEXT;');
    await pool.query('ALTER TABLE persona_overrides ADD COLUMN IF NOT EXISTS base_profile_id TEXT;');
    await pool.query('ALTER TABLE persona_overrides ADD COLUMN IF NOT EXISTS mood TEXT;');
    await pool.query('ALTER TABLE persona_overrides ADD COLUMN IF NOT EXISTS style_overrides TEXT;');
    await pool.query('ALTER TABLE persona_overrides ADD COLUMN IF NOT EXISTS personality_prompt TEXT;');
    await pool.query('ALTER TABLE persona_overrides ADD COLUMN IF NOT EXISTS runtime_overrides TEXT;');
}

async function load() {
    if (db.isEnabled()) {
        const pool = db.getPool();
        await ensureTable(pool);
        const { rows } = await pool.query('SELECT * FROM persona_overrides WHERE id = 1');
        const row = rows[0];
        if (row) {
            let baseProfileId = row.base_profile_id || null;
            let mood = row.mood || 'calm';
            let style = {};
            try {
                style = row.style_overrides ? JSON.parse(row.style_overrides) : {};
            } catch {
                style = {};
            }

            let runtimeByProvider = {};
            if (row.runtime_overrides) {
                try {
                    runtimeByProvider = JSON.parse(row.runtime_overrides);
                    if (typeof runtimeByProvider !== 'object' || runtimeByProvider === null) {
                        runtimeByProvider = {};
                    }
                } catch (error) {
                    console.warn(`[WineAI] Failed to parse runtime_overrides JSON for row id=1: ${error.message}`);
                    runtimeByProvider = {};
                }
            }

            // Legacy Migration logic:
            // If baseProfileId is missing, check if legacy overrides exist.
            // If so, load as customizationMode = custom, baseProfileId = null.
            // If completely empty, default baseProfileId to classic preset.
            const hasLegacyOverrides = Boolean(row.name || row.description || row.welcome_message || row.system_prompt || row.sommelier_gender);
            const hasNestedOverrides = Object.keys(style).length > 0 || Object.keys(runtimeByProvider).length > 0;
            const hasAnyOverrides = hasLegacyOverrides || hasNestedOverrides;
            if (baseProfileId === null && !hasAnyOverrides) {
                baseProfileId = 'classic';
            }

            const overrides = {};
            if (row.name) overrides.name = row.name;
            if (row.description) overrides.description = row.description;
            if (row.welcome_message) overrides.welcome_message = row.welcome_message;
            if (row.system_prompt) overrides.system_prompt = row.system_prompt;
            if (row.sommelier_gender) overrides.sommelierGender = row.sommelier_gender;
            if (row.personality_prompt) overrides.personalityPrompt = row.personality_prompt;
            if (Object.keys(style).length > 0) overrides.style = style;
            if (Object.keys(runtimeByProvider).length > 0) overrides.runtimeByProvider = runtimeByProvider;

            cache = {
                baseProfileId,
                mood,
                overrides,
                name: overrides.name || '',
                description: overrides.description || '',
                welcome_message: overrides.welcome_message || '',
                system_prompt: overrides.system_prompt || '',
                sommelierGender: overrides.sommelierGender || DEFAULT_SOMMELIER_GENDER,
                personalityPrompt: overrides.personalityPrompt || ''
            };
        } else {
            cache = {
                baseProfileId: 'classic',
                mood: 'calm',
                overrides: {},
                name: '',
                description: '',
                welcome_message: '',
                system_prompt: '',
                sommelierGender: DEFAULT_SOMMELIER_GENDER,
                personalityPrompt: ''
            };
        }
        return cache;
    }

    try {
        if (fs.existsSync(FILE_PATH)) {
            const raw = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8')) || {};
            let baseProfileId = raw.baseProfileId !== undefined ? raw.baseProfileId : null;
            let mood = raw.mood || 'calm';
            const overrides = raw.overrides || {};
            if (overrides.runtimeByProvider) {
                if (typeof overrides.runtimeByProvider !== 'object' || overrides.runtimeByProvider === null) {
                    console.warn('[WineAI] Failed to parse runtime_overrides JSON from file: not an object');
                    delete overrides.runtimeByProvider;
                }
            }

            const hasLegacyOverrides = Boolean(raw.name || raw.description || raw.welcome_message || raw.system_prompt || raw.sommelierGender);
            if (baseProfileId === null && hasLegacyOverrides) {
                overrides.name = raw.name;
                overrides.description = raw.description;
                overrides.welcome_message = raw.welcome_message;
                overrides.system_prompt = raw.system_prompt;
                overrides.sommelierGender = raw.sommelierGender;
            } else if (baseProfileId === null && !hasLegacyOverrides && Object.keys(overrides).length === 0) {
                baseProfileId = 'classic';
            }

            cache = {
                baseProfileId,
                mood,
                overrides,
                name: overrides.name || '',
                description: overrides.description || '',
                welcome_message: overrides.welcome_message || '',
                system_prompt: overrides.system_prompt || '',
                sommelierGender: overrides.sommelierGender || DEFAULT_SOMMELIER_GENDER,
                personalityPrompt: overrides.personalityPrompt || ''
            };
        } else {
            cache = {
                baseProfileId: 'classic',
                mood: 'calm',
                overrides: {},
                name: '',
                description: '',
                welcome_message: '',
                system_prompt: '',
                sommelierGender: DEFAULT_SOMMELIER_GENDER,
                personalityPrompt: ''
            };
        }
    } catch {
        cache = {
            baseProfileId: 'classic',
            mood: 'calm',
            overrides: {},
            name: '',
            description: '',
            welcome_message: '',
            system_prompt: '',
            sommelierGender: DEFAULT_SOMMELIER_GENDER,
            personalityPrompt: ''
        };
    }
    return cache;
}

async function save(partial) {
    const legacyFields = ['name', 'description', 'welcome_message', 'system_prompt', 'sommelierGender', 'personalityPrompt'];
    const hasLegacyRoot = legacyFields.some(f => partial && partial[f] !== undefined);
    if (hasLegacyRoot) {
        partial = { ...partial };
        partial.overrides = partial.overrides ? { ...partial.overrides } : {};
        for (const field of legacyFields) {
            if (partial[field] !== undefined) {
                partial.overrides[field] = partial[field];
                delete partial[field];
            }
        }
    }

    let baseProfileId = cache.baseProfileId;
    let mood = cache.mood;
    let overrides = { ...cache.overrides };

    if (partial.reset) {
        if (baseProfileId === null) {
            const err = new Error('Cannot reset a custom profile. Please select a built-in preset profile first.');
            err.statusCode = 400;
            throw err;
        }
        overrides = {};
    } else if (partial.baseProfileId !== undefined) {
        const val = partial.baseProfileId;
        if (val !== null && val !== 'classic' && val !== 'warm_guide') {
            const err = new Error('invalid_base_profile_id');
            err.statusCode = 400;
            throw err;
        }
        baseProfileId = val;
        overrides = {}; // Purge overrides when switching presets
    }

    if (partial.mood !== undefined) {
        const allowedMoods = ['calm', 'warm', 'lively', 'expert'];
        if (!allowedMoods.includes(partial.mood)) {
            const err = new Error('invalid_mood');
            err.statusCode = 400;
            throw err;
        }
        mood = partial.mood;
    }

    if (!partial.reset && partial.baseProfileId === undefined) {
        if (partial.overrides !== undefined && partial.overrides !== null) {
            const keys = Object.keys(partial.overrides);
            const allowedKeys = ['name', 'description', 'welcome_message', 'system_prompt', 'sommelierGender', 'personalityPrompt', 'style', 'runtimeByProvider'];

            for (const key of keys) {
                if (!allowedKeys.includes(key)) {
                    const err = new Error(`Unknown field: ${key}`);
                    err.statusCode = 400;
                    throw err;
                }
            }

            for (const key of ['name', 'description', 'welcome_message', 'system_prompt', 'sommelierGender', 'personalityPrompt']) {
                if (partial.overrides[key] !== undefined) {
                    const val = partial.overrides[key];
                    if (key === 'sommelierGender') {
                        if (val === null || val === '') {
                            const err = new Error('invalid_sommelier_gender');
                            err.statusCode = 400;
                            throw err;
                        }
                        if (typeof val !== 'string' || !ALLOWED_GENDERS.includes(val)) {
                            const err = new Error('invalid_sommelier_gender');
                            err.statusCode = 400;
                            throw err;
                        }
                    }
                    if (val === null) {
                        delete overrides[key];
                    } else if (typeof val === 'string') {
                        const limit = { name: 80, description: 400, welcome_message: 600, system_prompt: 24000, personalityPrompt: 24000 }[key];
                        overrides[key] = val.trim().slice(0, limit);
                    } else {
                        const err = new Error(`Invalid type for field ${key}`);
                        err.statusCode = 400;
                        throw err;
                    }
                }
            }

            if (partial.overrides.style !== undefined && partial.overrides.style !== null) {
                if (typeof partial.overrides.style !== 'object') {
                    const err = new Error('style must be an object');
                    err.statusCode = 400;
                    throw err;
                }

                const styleOverrides = { ...overrides.style };
                const allowedStyleKeys = ['responseLength', 'humorLevel', 'tone', 'expertiseLevel', 'storytelling', 'proactiveSuggestions', 'toastStyle'];

                for (const [key, val] of Object.entries(partial.overrides.style)) {
                    if (!allowedStyleKeys.includes(key)) {
                        const err = new Error(`Unknown style field: ${key}`);
                        err.statusCode = 400;
                        throw err;
                    }
                    if (val === null) {
                        delete styleOverrides[key];
                    } else if (key === 'proactiveSuggestions') {
                        if (typeof val !== 'boolean') {
                            const err = new Error('proactiveSuggestions must be a boolean');
                            err.statusCode = 400;
                            throw err;
                        }
                        styleOverrides[key] = val;
                    } else {
                        if (typeof val !== 'string') {
                            const err = new Error(`${key} must be a string`);
                            err.statusCode = 400;
                            throw err;
                        }
                        const validValues = {
                            responseLength: ['short', 'balanced', 'detailed'],
                            humorLevel: ['none', 'light', 'expressive'],
                            tone: ['formal', 'warm', 'lively'],
                            expertiseLevel: ['beginnerFriendly', 'balanced', 'expert'],
                            storytelling: ['off', 'occasional', 'active'],
                            toastStyle: ['disabled', 'onRequest', 'occasional']
                        }[key];

                        if (validValues && !validValues.includes(val)) {
                            const err = new Error(`Invalid value for style key ${key}: ${val}`);
                            err.statusCode = 400;
                            throw err;
                        }
                        styleOverrides[key] = val;
                    }
                }

                overrides.style = styleOverrides;
                if (Object.keys(overrides.style).length === 0) {
                    delete overrides.style;
                }
            }

            if (partial.overrides.runtimeByProvider !== undefined && partial.overrides.runtimeByProvider !== null) {
                if (typeof partial.overrides.runtimeByProvider !== 'object') {
                    const err = new Error('runtimeByProvider must be an object');
                    err.statusCode = 400;
                    throw err;
                }

                const runtimeOverrides = { ...overrides.runtimeByProvider };
                const allowedProviders = ['gemini', 'grok', 'mock'];

                for (const [providerId, providerBlock] of Object.entries(partial.overrides.runtimeByProvider)) {
                    if (!allowedProviders.includes(providerId)) {
                        const err = new Error('unknown_provider');
                        err.statusCode = 400;
                        err.code = 'unknown_provider';
                        throw err;
                    }
                    if (providerId === 'mock') {
                        const err = new Error('unsupported_provider_capability');
                        err.statusCode = 400;
                        err.code = 'unsupported_provider_capability';
                        throw err;
                    }
                    if (providerBlock !== null && typeof providerBlock !== 'object') {
                        const err = new Error(`${providerId} block must be an object`);
                        err.statusCode = 400;
                        throw err;
                    }

                    if (providerBlock === null) {
                        delete runtimeOverrides[providerId];
                        continue;
                    }

                    const providerOverrides = { ...(runtimeOverrides[providerId] || {}) };

                    for (const [key, val] of Object.entries(providerBlock)) {
                        if (key === 'modelId') {
                            const err = new Error('unsupported_runtime_field');
                            err.statusCode = 400;
                            err.code = 'unsupported_runtime_field';
                            throw err;
                        }
                        if (key !== 'voiceId') {
                            const err = new Error(`Unknown runtime field: ${key}`);
                            err.statusCode = 400;
                            throw err;
                        }

                        if (val === null) {
                            delete providerOverrides[key];
                        } else {
                            if (typeof val !== 'string') {
                                const err = new Error(`${key} must be a string`);
                                err.statusCode = 400;
                                throw err;
                            }
                            if (providerId === 'gemini') {
                                const { GEMINI_VOICE_NAMES } = require('../geminiVoices');
                                if (!GEMINI_VOICE_NAMES.includes(val)) {
                                    const err = new Error('invalid_voice_id');
                                    err.statusCode = 400;
                                    err.code = 'invalid_voice_id';
                                    throw err;
                                }
                            } else if (providerId === 'grok') {
                                const { GROK_VOICES } = require('../grokVoices');
                                const knownGrok = GROK_VOICES.map(v => v.id);
                                if (!knownGrok.includes(val)) {
                                    const err = new Error('invalid_voice_id');
                                    err.statusCode = 400;
                                    err.code = 'invalid_voice_id';
                                    throw err;
                                }
                            }
                            providerOverrides[key] = val;
                        }
                    }

                    runtimeOverrides[providerId] = providerOverrides;
                    if (Object.keys(runtimeOverrides[providerId]).length === 0) {
                        delete runtimeOverrides[providerId];
                    }
                }

                overrides.runtimeByProvider = runtimeOverrides;
                if (Object.keys(overrides.runtimeByProvider).length === 0) {
                    delete overrides.runtimeByProvider;
                }
            }
        }
    }

    cache = {
        baseProfileId,
        mood,
        overrides,
        name: overrides.name || '',
        description: overrides.description || '',
        welcome_message: overrides.welcome_message || '',
        system_prompt: overrides.system_prompt || '',
        sommelierGender: overrides.sommelierGender || DEFAULT_SOMMELIER_GENDER,
        personalityPrompt: overrides.personalityPrompt || ''
    };

    if (db.isEnabled()) {
        const pool = db.getPool();
        await ensureTable(pool);
        const styleStr = overrides.style ? JSON.stringify(overrides.style) : null;
        const runtimeStr = overrides.runtimeByProvider ? JSON.stringify(overrides.runtimeByProvider) : null;
        await pool.query(
            `INSERT INTO persona_overrides (id, name, description, welcome_message, system_prompt, sommelier_gender, base_profile_id, mood, style_overrides, personality_prompt, runtime_overrides, updated_at)
             VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name, description = EXCLUDED.description,
                welcome_message = EXCLUDED.welcome_message, system_prompt = EXCLUDED.system_prompt,
                sommelier_gender = EXCLUDED.sommelier_gender, base_profile_id = EXCLUDED.base_profile_id,
                mood = EXCLUDED.mood, style_overrides = EXCLUDED.style_overrides,
                personality_prompt = EXCLUDED.personality_prompt, runtime_overrides = EXCLUDED.runtime_overrides,
                updated_at = EXCLUDED.updated_at`,
            [
                overrides.name || null,
                overrides.description || null,
                overrides.welcome_message || null,
                overrides.system_prompt || null,
                overrides.sommelierGender || null,
                baseProfileId,
                mood,
                styleStr,
                overrides.personalityPrompt || null,
                runtimeStr,
                new Date().toISOString()
            ]
        );
    } else {
        fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
        fs.writeFileSync(FILE_PATH, JSON.stringify({
            baseProfileId,
            mood,
            overrides
        }, null, 2), 'utf8');
    }

    return cache;
}

function getCached() {
    return cache;
}

module.exports = {
    load,
    save,
    getCached,
    DEFAULT_SOMMELIER_GENDER,
    ALLOWED_GENDERS
};
