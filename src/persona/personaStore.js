'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../knowledge/db');
const { getProfileById } = require('./profileRegistry');

const FILE_PATH = process.env.PERSONA_OVERRIDES_FILE || path.resolve(__dirname, '..', '..', 'data', 'persona-overrides.json');
const ALLOWED_GENDERS = ['male', 'female'];
const DEFAULT_SOMMELIER_GENDER = 'male';

const ALLOWED_VOICE_MODES = ['hold_to_talk', 'tap_to_start'];
const DEFAULT_VOICE_MODE = 'hold_to_talk';

// Scoped in-memory cache
let cache = {
    activeProfileId: 'classic',
    // Device-wide UX preference (Hold to Talk vs. Tap to Start), not tied
    // to which persona profile is active — stored alongside activeProfileId
    // in persona_active_state (or the file's top level), not inside a
    // profile's `overrides` (which is persona content, not device UX).
    voiceMode: DEFAULT_VOICE_MODE,
    profiles: {
        classic: { overrides: {} },
        warm_guide: { overrides: {} }
    }
};
let loadError = null;

async function load() {
    loadError = null;
    if (db.isEnabled()) {
        const pool = db.getPool();
        let client;
        try {
            client = await pool.connect();
        } catch (connectErr) {
            loadError = connectErr;
            console.error('[WineAI] Database connection failed. Raising Service Unavailable:', connectErr);
            throw connectErr;
        }
        try {
            await client.query('BEGIN');

            // 1. Create tables
            await client.query(`
                CREATE TABLE IF NOT EXISTS persona_profile_settings (
                    profile_id TEXT PRIMARY KEY,
                    overrides_json JSONB NOT NULL DEFAULT '{}',
                    created_at TIMESTAMPTZ NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL
                );
            `);
            await client.query(`
                CREATE TABLE IF NOT EXISTS persona_active_state (
                    state_key TEXT PRIMARY KEY,
                    active_profile_id TEXT NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL
                );
            `);
            await client.query('ALTER TABLE persona_active_state ADD COLUMN IF NOT EXISTS voice_mode TEXT;');

            // 2. Check if active state exists
            const activeRes = await client.query("SELECT active_profile_id FROM persona_active_state WHERE state_key = 'default'");

            if (activeRes.rows.length === 0) {
                console.log('[WineAI] Performing legacy singleton to profile-scoped settings database migration...');

                let legacyRow = null;
                try {
                    const legacyRes = await client.query("SELECT * FROM persona_overrides WHERE id = 1");
                    legacyRow = legacyRes.rows[0];
                } catch (e) {
                    console.log('[WineAI] Legacy persona_overrides table not found or empty, skipping migration of historical data.');
                }

                let activeProfileId = 'classic';
                const nowStr = new Date().toISOString();

                // Reconstruct overrides if legacy data exists
                const legacyOverrides = {};
                if (legacyRow) {
                    activeProfileId = legacyRow.base_profile_id || 'classic';
                    if (legacyRow.name) legacyOverrides.name = legacyRow.name;
                    if (legacyRow.description) legacyOverrides.description = legacyRow.description;
                    if (legacyRow.welcome_message) legacyOverrides.welcomeMessage = legacyRow.welcome_message;
                    if (legacyRow.sommelier_gender) legacyOverrides.sommelierGender = legacyRow.sommelier_gender;
                    if (legacyRow.system_prompt) legacyOverrides.systemPrompt = legacyRow.system_prompt;
                    if (legacyRow.personality_prompt) legacyOverrides.personalityPrompt = legacyRow.personality_prompt;
                    if (legacyRow.mood) legacyOverrides.mood = legacyRow.mood;

                    if (legacyRow.style_overrides) {
                        try { legacyOverrides.style = JSON.parse(legacyRow.style_overrides); } catch {}
                    }
                    if (legacyRow.runtime_overrides) {
                        try { legacyOverrides.runtimeByProvider = JSON.parse(legacyRow.runtime_overrides); } catch {}
                    }
                    if (legacyRow.identity_overrides) {
                        try { legacyOverrides.identity = JSON.parse(legacyRow.identity_overrides); } catch {}
                    }
                }

                // Insert active state
                await client.query(
                    `INSERT INTO persona_active_state (state_key, active_profile_id, voice_mode, updated_at)
                     VALUES ('default', $1, $2, $3)`,
                    [activeProfileId, DEFAULT_VOICE_MODE, nowStr]
                );

                // Insert profile rows (without resolved defaults, only overrides)
                await client.query(
                    `INSERT INTO persona_profile_settings (profile_id, overrides_json, created_at, updated_at)
                     VALUES ('classic', $1, $2, $2)`,
                    [JSON.stringify(activeProfileId === 'classic' ? legacyOverrides : {}), nowStr]
                );
                await client.query(
                    `INSERT INTO persona_profile_settings (profile_id, overrides_json, created_at, updated_at)
                     VALUES ('warm_guide', $1, $2, $2)`,
                    [JSON.stringify(activeProfileId === 'warm_guide' ? legacyOverrides : {}), nowStr]
                );
            } else {
                // Active state already exists. Idempotent Invariant Check:
                // Ensure profile settings rows exist for both builtin profiles, repair if missing!
                const nowStr = new Date().toISOString();
                await client.query(
                    `INSERT INTO persona_profile_settings (profile_id, overrides_json, created_at, updated_at)
                     VALUES ('classic', '{}', $1, $1) ON CONFLICT DO NOTHING`,
                    [nowStr]
                );
                await client.query(
                    `INSERT INTO persona_profile_settings (profile_id, overrides_json, created_at, updated_at)
                     VALUES ('warm_guide', '{}', $1, $1) ON CONFLICT DO NOTHING`,
                    [nowStr]
                );
            }

            // 3. Load active state and settings
            const activeState = (await client.query("SELECT active_profile_id, voice_mode FROM persona_active_state WHERE state_key = 'default'")).rows[0];
            const profilesRows = (await client.query("SELECT profile_id, overrides_json FROM persona_profile_settings")).rows;

            await client.query('COMMIT');

            const activeProfileId = activeState ? activeState.active_profile_id : 'classic';
            const voiceMode = ALLOWED_VOICE_MODES.includes(activeState?.voice_mode) ? activeState.voice_mode : DEFAULT_VOICE_MODE;

            const profiles = {};
            for (const row of profilesRows) {
                const overrides = typeof row.overrides_json === 'object' ? row.overrides_json : JSON.parse(row.overrides_json || '{}');
                if (overrides.runtimeByProvider && typeof overrides.runtimeByProvider !== 'object') {
                    delete overrides.runtimeByProvider;
                }
                if (overrides.style && typeof overrides.style !== 'object') {
                    delete overrides.style;
                }
                if (overrides.identity && typeof overrides.identity !== 'object') {
                    delete overrides.identity;
                }
                profiles[row.profile_id] = { overrides };
            }

            // Repair cache if database has rows but missing registry definitions
            if (!profiles.classic) profiles.classic = { overrides: {} };
            if (!profiles.warm_guide) profiles.warm_guide = { overrides: {} };

            cache = {
                activeProfileId,
                voiceMode,
                profiles
            };
        } catch (err) {
            await client.query('ROLLBACK');
            loadError = err;
            console.error('[WineAI] Database migration failed. Raising Service Unavailable:', err);
            throw err; // DO NOT swallow the error, return 503 as requested!
        } finally {
            client.release();
        }
    } else {
        // Filesystem JSON migration (atomic replace)
        try {
            if (fs.existsSync(FILE_PATH)) {
                const raw = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8')) || {};
                if (raw.profiles === undefined && (raw.baseProfileId !== undefined || raw.overrides !== undefined)) {
                    console.log('[WineAI] Performing legacy JSON to profile-scoped settings migration...');
                    const activeProfileId = raw.baseProfileId || 'classic';
                    const activeMood = raw.mood || 'calm';
                    const oldOverrides = raw.overrides || {};
                    if (oldOverrides.runtimeByProvider && typeof oldOverrides.runtimeByProvider !== 'object') {
                        delete oldOverrides.runtimeByProvider;
                    }
                    if (oldOverrides.style && typeof oldOverrides.style !== 'object') {
                        delete oldOverrides.style;
                    }
                    if (oldOverrides.identity && typeof oldOverrides.identity !== 'object') {
                        delete oldOverrides.identity;
                    }
                    if (!oldOverrides.mood && activeMood) oldOverrides.mood = activeMood;

                    cache = {
                        activeProfileId,
                        voiceMode: ALLOWED_VOICE_MODES.includes(raw.voiceMode) ? raw.voiceMode : DEFAULT_VOICE_MODE,
                        profiles: {
                            classic: activeProfileId === 'classic' ? { overrides: oldOverrides } : { overrides: {} },
                            warm_guide: activeProfileId === 'warm_guide' ? { overrides: oldOverrides } : { overrides: {} }
                        }
                    };
                } else {
                    const classicOverrides = raw.profiles?.classic?.overrides || {};
                    const warmOverrides = raw.profiles?.warm_guide?.overrides || {};
                    for (const o of [classicOverrides, warmOverrides]) {
                        if (o.runtimeByProvider && typeof o.runtimeByProvider !== 'object') {
                            delete o.runtimeByProvider;
                        }
                        if (o.style && typeof o.style !== 'object') {
                            delete o.style;
                        }
                        if (o.identity && typeof o.identity !== 'object') {
                            delete o.identity;
                        }
                    }
                    cache = {
                        activeProfileId: raw.activeProfileId || 'classic',
                        voiceMode: ALLOWED_VOICE_MODES.includes(raw.voiceMode) ? raw.voiceMode : DEFAULT_VOICE_MODE,
                        profiles: {
                            classic: { overrides: classicOverrides },
                            warm_guide: { overrides: warmOverrides }
                        }
                    };
                }
            } else {
                cache = {
                    activeProfileId: 'classic',
                    voiceMode: DEFAULT_VOICE_MODE,
                    profiles: {
                        classic: { overrides: {} },
                        warm_guide: { overrides: {} }
                    }
                };
            }
        } catch (err) {
            console.error('[WineAI] Filesystem migration failed. Raising Service Unavailable:', err);
            loadError = err;
            throw err;
        }
    }
    return getCached();
}

function getLoadError() {
    return loadError;
}

function getActiveProfileId() {
    return cache.activeProfileId;
}

function getProfile(profileId) {
    const builtin = getProfileById(profileId);
    if (!builtin) {
        const err = new Error(`invalid_profile_id: ${profileId}`);
        err.statusCode = 400;
        throw err;
    }
    const overrides = cache.profiles[profileId]?.overrides || {};
    const mood = overrides.mood || builtin.mood || 'calm';
    const { resolveProfile } = require('./profileRegistry');
    return resolveProfile(profileId, overrides, mood);
}

function getActiveProfile() {
    return getProfile(cache.activeProfileId);
}

function getCached() {
    const activeProfileId = cache.activeProfileId;
    const builtin = getProfileById(activeProfileId);
    const rawOverrides = cache.profiles[activeProfileId]?.overrides || {};
    const hasMeaningfulOverrides = Object.keys(rawOverrides).some(key => {
        if (key === 'mood') return false;
        if (key === 'style') return Object.keys(rawOverrides.style || {}).length > 0;
        if (key === 'runtimeByProvider') return Object.keys(rawOverrides.runtimeByProvider || {}).length > 0;
        if (key === 'identity') return Object.keys(rawOverrides.identity || {}).length > 0;
        return rawOverrides[key] !== undefined && rawOverrides[key] !== null;
    });
    const overrides = { ...rawOverrides };
    const mood = overrides.mood || builtin?.mood || 'calm';
    delete overrides.mood;
    return {
        baseProfileId: activeProfileId,
        customProfile: hasMeaningfulOverrides,
        mood,
        voiceMode: ALLOWED_VOICE_MODES.includes(cache.voiceMode) ? cache.voiceMode : DEFAULT_VOICE_MODE,
        overrides
    };
}

function getProfilesOverrides() {
    return cache.profiles;
}

function validateAndMergeOverrides(current, patch) {
    const overrides = JSON.parse(JSON.stringify(current || {}));

    if (!patch) return overrides;

    const allowedKeys = ['name', 'description', 'welcomeMessage', 'sommelierGender', 'systemPrompt', 'personalityPrompt', 'mood', 'style', 'runtimeByProvider', 'identity'];
    for (const key of Object.keys(patch)) {
        if (!allowedKeys.includes(key)) {
            const err = new Error('unsupported_override_field');
            err.statusCode = 400;
            throw err;
        }
    }

    for (const key of ['name', 'description', 'welcomeMessage', 'systemPrompt', 'personalityPrompt', 'mood']) {
        if (patch[key] !== undefined) {
            const val = patch[key];
            if (val === null) {
                delete overrides[key];
            } else if (typeof val === 'string') {
                if (key === 'mood') {
                    const allowedMoods = ['calm', 'warm', 'lively', 'expert'];
                    if (!allowedMoods.includes(val)) {
                        const err = new Error('invalid_mood');
                        err.statusCode = 400;
                        throw err;
                    }
                    overrides.mood = val;
                } else {
                    const limit = { name: 80, description: 400, welcomeMessage: 600, systemPrompt: 24000, personalityPrompt: 24000 }[key];
                    overrides[key] = val.trim().slice(0, limit);
                }
            } else {
                const err = new Error(`Invalid type for field ${key}`);
                err.statusCode = 400;
                throw err;
            }
        }
    }

    if (patch.sommelierGender !== undefined) {
        const val = patch.sommelierGender;
        if (typeof val !== 'string' || !ALLOWED_GENDERS.includes(val)) {
            const err = new Error('invalid_sommelier_gender');
            err.statusCode = 400;
            throw err;
        }
        overrides.sommelierGender = val;
    }

    if (patch.style !== undefined && patch.style !== null) {
        if (typeof patch.style !== 'object') {
            const err = new Error('style must be an object');
            err.statusCode = 400;
            throw err;
        }
        if (!overrides.style) overrides.style = {};

        const allowedStyleKeys = [
            'responseLength', 'humorLevel', 'tone', 'expertiseLevel', 'storytelling',
            'proactiveSuggestions', 'toastStyle', 'conversationMode', 'askFollowUpQuestions',
            'useHumor', 'talkAboutSelf', 'supportSmallTalk', 'softlyReturnToWine',
            'useFictionalBiography', 'responseVariety'
        ];

        for (const [key, val] of Object.entries(patch.style)) {
            if (!allowedStyleKeys.includes(key)) {
                const err = new Error(`Unknown style field: ${key}`);
                err.statusCode = 400;
                throw err;
            }
            if (val === null) {
                delete overrides.style[key];
            } else if (['proactiveSuggestions', 'askFollowUpQuestions', 'useHumor', 'talkAboutSelf', 'supportSmallTalk', 'softlyReturnToWine', 'useFictionalBiography'].includes(key)) {
                if (typeof val !== 'boolean') {
                    const err = new Error(`${key} must be a boolean`);
                    err.statusCode = 400;
                    throw err;
                }
                overrides.style[key] = val;
            } else if (key === 'responseLength') {
                if (typeof val !== 'string' || !['brief', 'balanced', 'detailed', 'short'].includes(val)) {
                    const err = new Error('invalid_response_length');
                    err.statusCode = 400;
                    throw err;
                }
                overrides.style[key] = val;
            } else if (key === 'responseVariety') {
                if (typeof val !== 'string' || !['stable', 'natural', 'expressive'].includes(val)) {
                    const err = new Error('invalid_response_variety');
                    err.statusCode = 400;
                    throw err;
                }
                overrides.style[key] = val;
            } else if (key === 'conversationMode') {
                if (typeof val !== 'string' || !['strict', 'friendly', 'free'].includes(val)) {
                    const err = new Error('invalid_conversation_mode');
                    err.statusCode = 400;
                    throw err;
                }
                overrides.style[key] = val;
            } else {
                if (typeof val !== 'string') {
                    const err = new Error(`${key} must be a string`);
                    err.statusCode = 400;
                    throw err;
                }
                overrides.style[key] = val.trim().slice(0, 200);
            }
        }
        if (Object.keys(overrides.style).length === 0) {
            delete overrides.style;
        }
    }

    if (patch.runtimeByProvider !== undefined && patch.runtimeByProvider !== null) {
        if (typeof patch.runtimeByProvider !== 'object') {
            const err = new Error('runtimeByProvider must be an object');
            err.statusCode = 400;
            throw err;
        }
        if (!overrides.runtimeByProvider) overrides.runtimeByProvider = {};

        for (const [providerId, providerBlock] of Object.entries(patch.runtimeByProvider)) {
            if (providerId !== 'gemini' && providerId !== 'grok') {
                const errCode = providerId === 'mock' ? 'unsupported_provider_capability' : 'unknown_provider';
                const err = new Error(errCode);
                err.statusCode = 400;
                throw err;
            }
            if (providerBlock === null) {
                delete overrides.runtimeByProvider[providerId];
                continue;
            }
            if (typeof providerBlock !== 'object') {
                const err = new Error(`${providerId} block must be an object`);
                err.statusCode = 400;
                throw err;
            }

            if (!overrides.runtimeByProvider[providerId]) overrides.runtimeByProvider[providerId] = {};

            for (const [key, val] of Object.entries(providerBlock)) {
                if (key !== 'voiceId') {
                    const err = new Error('unsupported_runtime_field');
                    err.statusCode = 400;
                    throw err;
                }
                if (val === null) {
                    delete overrides.runtimeByProvider[providerId][key];
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
                            throw err;
                        }
                    } else if (providerId === 'grok') {
                        const { GROK_VOICES } = require('../grokVoices');
                        const isValid = GROK_VOICES.some(v => v.id === val || v.name === val || v.name.toLowerCase() === val.toLowerCase());
                        if (!isValid) {
                            const err = new Error('invalid_voice_id');
                            err.statusCode = 400;
                            throw err;
                        }
                    }
                    overrides.runtimeByProvider[providerId][key] = val;
                }
            }
            if (Object.keys(overrides.runtimeByProvider[providerId]).length === 0) {
                delete overrides.runtimeByProvider[providerId];
            }
        }
        if (Object.keys(overrides.runtimeByProvider).length === 0) {
            delete overrides.runtimeByProvider;
        }
    }

    if (patch.identity !== undefined && patch.identity !== null) {
        if (typeof patch.identity !== 'object') {
            const err = new Error('identity must be an object');
            err.statusCode = 400;
            throw err;
        }
        if (!overrides.identity) overrides.identity = {};

        const allowedIdentityKeys = ['background', 'creatorDescription', 'roleDescription', 'selfAdvantages', 'selfLimitations', 'wineAffinity', 'interests'];
        for (const [key, val] of Object.entries(patch.identity)) {
            if (!allowedIdentityKeys.includes(key)) {
                const err = new Error(`Unknown identity field: ${key}`);
                err.statusCode = 400;
                throw err;
            }
            if (val === null) {
                delete overrides.identity[key];
            } else if (key === 'interests') {
                if (!Array.isArray(val)) {
                    const err = new Error('interests must be an array');
                    err.statusCode = 400;
                    throw err;
                }
                if (val.length > 15) {
                    const err = new Error('interests array must not exceed 15 elements');
                    err.statusCode = 400;
                    throw err;
                }
                const cleanInterests = [];
                for (const item of val) {
                    if (typeof item !== 'string') {
                        const err = new Error('interests elements must be strings');
                        err.statusCode = 400;
                        throw err;
                    }
                    const cleaned = item.trim().slice(0, 60);
                    if (cleaned) {
                        cleanInterests.push(cleaned);
                    }
                }
                overrides.identity[key] = cleanInterests;
            } else {
                if (typeof val !== 'string') {
                    const err = new Error(`${key} must be a string`);
                    err.statusCode = 400;
                    throw err;
                }
                overrides.identity[key] = val.trim().slice(0, 2000);
            }
        }
        if (Object.keys(overrides.identity).length === 0) {
            delete overrides.identity;
        }
    }

    return overrides;
}

async function updateProfile(profileId, patch) {
    const builtin = getProfileById(profileId);
    if (!builtin) {
        const err = new Error(`invalid_profile_id: ${profileId}`);
        err.statusCode = 400;
        throw err;
    }

    if (db.isEnabled()) {
        const pool = db.getPool();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const { rows } = await client.query(
                'SELECT overrides_json FROM persona_profile_settings WHERE profile_id = $1 FOR UPDATE',
                [profileId]
            );
            if (rows.length === 0) {
                throw new Error(`Profile row ${profileId} not found in database`);
            }

            const currentOverrides = rows[0].overrides_json || {};
            const merged = validateAndMergeOverrides(currentOverrides, patch);

            await client.query(
                `UPDATE persona_profile_settings
                 SET overrides_json = $1, updated_at = $2
                 WHERE profile_id = $3`,
                [JSON.stringify(merged), new Date().toISOString(), profileId]
            );

            await client.query('COMMIT');

            cache.profiles[profileId] = { overrides: merged };
        } catch (err) {
            await client.query('ROLLBACK');
            console.error(`[WineAI] updateProfile transaction failed for ${profileId}:`, err);
            throw err;
        } finally {
            client.release();
        }
    } else {
        try {
            const current = cache.profiles[profileId]?.overrides || {};
            const merged = validateAndMergeOverrides(current, patch);

            cache.profiles[profileId] = { overrides: merged };

            fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
            const tmpPath = FILE_PATH + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), 'utf8');
            fs.renameSync(tmpPath, FILE_PATH);
        } catch (err) {
            console.error(`[WineAI] File write failed in updateProfile for ${profileId}:`, err);
            throw err;
        }
    }
    return getProfile(profileId);
}

async function resetProfile(profileId) {
    const builtin = getProfileById(profileId);
    if (!builtin) {
        const err = new Error(`invalid_profile_id: ${profileId}`);
        err.statusCode = 400;
        throw err;
    }

    if (db.isEnabled()) {
        const pool = db.getPool();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                `UPDATE persona_profile_settings
                 SET overrides_json = '{}', updated_at = $1
                 WHERE profile_id = $2`,
                [new Date().toISOString(), profileId]
            );
            await client.query('COMMIT');
            cache.profiles[profileId] = { overrides: {} };
        } catch (err) {
            await client.query('ROLLBACK');
            console.error(`[WineAI] resetProfile transaction failed for ${profileId}:`, err);
            throw err;
        } finally {
            client.release();
        }
    } else {
        try {
            cache.profiles[profileId] = { overrides: {} };
            fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
            const tmpPath = FILE_PATH + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), 'utf8');
            fs.renameSync(tmpPath, FILE_PATH);
        } catch (err) {
            console.error(`[WineAI] File write failed in resetProfile for ${profileId}:`, err);
            throw err;
        }
    }
    return getProfile(profileId);
}

async function activateProfile(profileId) {
    const builtin = getProfileById(profileId);
    if (!builtin) {
        const err = new Error(`invalid_profile_id: ${profileId}`);
        err.statusCode = 400;
        throw err;
    }

    if (db.isEnabled()) {
        const pool = db.getPool();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                `INSERT INTO persona_active_state (state_key, active_profile_id, updated_at)
                 VALUES ('default', $1, $2)
                 ON CONFLICT (state_key) DO UPDATE SET active_profile_id = EXCLUDED.active_profile_id, updated_at = EXCLUDED.updated_at`,
                [profileId, new Date().toISOString()]
            );
            await client.query('COMMIT');
            cache.activeProfileId = profileId;
        } catch (err) {
            await client.query('ROLLBACK');
            console.error(`[WineAI] activateProfile transaction failed:`, err);
            throw err;
        } finally {
            client.release();
        }
    } else {
        try {
            cache.activeProfileId = profileId;
            fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
            const tmpPath = FILE_PATH + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), 'utf8');
            fs.renameSync(tmpPath, FILE_PATH);
        } catch (err) {
            console.error(`[WineAI] File write failed in activateProfile:`, err);
            throw err;
        }
    }
    return getProfile(profileId);
}

function getVoiceMode() {
    return ALLOWED_VOICE_MODES.includes(cache.voiceMode) ? cache.voiceMode : DEFAULT_VOICE_MODE;
}

// Device-wide UX preference, persisted the same way as activeProfileId
// (persona_active_state row / file top level) — NOT per-profile content,
// so it deliberately does not go through updateProfile()/validateAndMergeOverrides().
async function setVoiceMode(mode) {
    if (!ALLOWED_VOICE_MODES.includes(mode)) {
        const err = new Error('invalid_voice_mode');
        err.statusCode = 400;
        throw err;
    }

    if (db.isEnabled()) {
        const pool = db.getPool();
        await pool.query(
            `INSERT INTO persona_active_state (state_key, active_profile_id, voice_mode, updated_at)
             VALUES ('default', $1, $2, $3)
             ON CONFLICT (state_key) DO UPDATE SET voice_mode = EXCLUDED.voice_mode, updated_at = EXCLUDED.updated_at`,
            [cache.activeProfileId, mode, new Date().toISOString()]
        );
    } else {
        cache.voiceMode = mode;
        fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
        const tmpPath = FILE_PATH + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), 'utf8');
        fs.renameSync(tmpPath, FILE_PATH);
    }
    cache.voiceMode = mode;
    return getCached();
}

let legacyCustomProfile = false;

function setLegacyCustomProfile(val) {
    legacyCustomProfile = !!val;
}

function isLegacyCustomProfile() {
    return legacyCustomProfile;
}

async function save(body = {}) {
    if (body.voiceMode !== undefined) {
        await setVoiceMode(body.voiceMode);
    }

    if (body.baseProfileId === null) {
        setLegacyCustomProfile(true);
    } else if (body.baseProfileId !== undefined) {
        setLegacyCustomProfile(false);
        if (body.baseProfileId) {
            const currentActiveId = cache.activeProfileId;
            const currentActiveOverrides = cache.profiles[currentActiveId]?.overrides || {};
            const activeMood = currentActiveOverrides.mood || 'calm';

            await activateProfile(body.baseProfileId);
            await resetProfile(body.baseProfileId);
            if (activeMood && activeMood !== 'calm') {
                await updateProfile(body.baseProfileId, { mood: activeMood });
            }
        }
    }

    if (body.reset) {
        if (isLegacyCustomProfile()) {
            const err = new Error('Cannot reset a custom profile');
            err.statusCode = 400;
            throw err;
        }
        await resetProfile(cache.activeProfileId);
        return getCached();
    }

    const patch = { ...body.overrides };
    const flatKeys = ['name', 'description', 'welcomeMessage', 'sommelierGender', 'personalityPrompt', 'systemPrompt', 'mood', 'style', 'runtimeByProvider', 'identity'];
    for (const key of Object.keys(body)) {
        if (flatKeys.includes(key)) {
            patch[key] = body[key];
        }
    }
    if (Object.keys(patch).length > 0) {
        await updateProfile(cache.activeProfileId, patch);
    }
    return getCached();
}

function listProfileStates() {
    return Object.keys(cache.profiles).map(id => ({
        id,
        hasCustomSettings: Object.keys(cache.profiles[id]?.overrides || {}).length > 0
    }));
}

module.exports = {
    load,
    getLoadError,
    getActiveProfileId,
    getProfile,
    getActiveProfile,
    updateProfile,
    resetProfile,
    activateProfile,
    listProfileStates,
    getCached,
    getProfilesOverrides,
    save,
    isLegacyCustomProfile,
    setLegacyCustomProfile,
    getVoiceMode,
    setVoiceMode,
    DEFAULT_SOMMELIER_GENDER,
    DEFAULT_VOICE_MODE,
    ALLOWED_GENDERS,
    ALLOWED_VOICE_MODES
};
