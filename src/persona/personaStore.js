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
const ALLOWED_SESSION_LIMIT_MINUTES = [2.5, 3, 5, 10];
const DEFAULT_SESSION_LIMIT_MINUTES = 3;
const SESSION_LIMIT_CONTEXTS = ['kiosk', 'mobile_qr'];
const START_INTENT_LANGUAGES = ['ru', 'ro', 'en', 'fr', 'it', 'es', 'de', 'zh', 'ja'];
const START_INTENT_IDS = ['choose_wine', 'pair_food', 'learn_wine', 'visit_winery'];

let cache = {
    activeProfileId: 'classic',
    voiceMode: DEFAULT_VOICE_MODE,
    sessionLimitMinutes: DEFAULT_SESSION_LIMIT_MINUTES,
    sessionLimitMinutesByContext: { kiosk: null, mobile_qr: null },
    profiles: {
        classic: { overrides: {} },
        warm_guide: { overrides: {} }
    }
};
let loadError = null;
let legacyCustomProfile = false;

function cleanLoadedOverrides(overrides) {
    const value = overrides && typeof overrides === 'object' ? overrides : {};
    if (value.runtimeByProvider && typeof value.runtimeByProvider !== 'object') delete value.runtimeByProvider;
    if (value.style && typeof value.style !== 'object') delete value.style;
    if (value.identity && typeof value.identity !== 'object') delete value.identity;
    if (value.startIntents && typeof value.startIntents !== 'object') delete value.startIntents;
    return value;
}

function defaultCache() {
    return {
        activeProfileId: 'classic',
        voiceMode: DEFAULT_VOICE_MODE,
        sessionLimitMinutes: DEFAULT_SESSION_LIMIT_MINUTES,
        sessionLimitMinutesByContext: { kiosk: null, mobile_qr: null },
        profiles: {
            classic: { overrides: {} },
            warm_guide: { overrides: {} }
        }
    };
}

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
            await client.query('ALTER TABLE persona_active_state ADD COLUMN IF NOT EXISTS session_limit_minutes NUMERIC;');
            await client.query('ALTER TABLE persona_active_state ADD COLUMN IF NOT EXISTS session_limit_minutes_kiosk NUMERIC;');
            await client.query('ALTER TABLE persona_active_state ADD COLUMN IF NOT EXISTS session_limit_minutes_mobile_qr NUMERIC;');

            const activeRes = await client.query("SELECT active_profile_id FROM persona_active_state WHERE state_key = 'default'");
            if (activeRes.rows.length === 0) {
                console.log('[WineAI] Performing legacy singleton to profile-scoped settings database migration...');
                let legacyRow = null;
                try {
                    const legacyRes = await client.query('SELECT * FROM persona_overrides WHERE id = 1');
                    legacyRow = legacyRes.rows[0];
                } catch {
                    console.log('[WineAI] Legacy persona_overrides table not found or empty, skipping migration of historical data.');
                }
                let activeProfileId = 'classic';
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
                const nowStr = new Date().toISOString();
                await client.query(
                    `INSERT INTO persona_active_state (state_key, active_profile_id, voice_mode, updated_at)
                     VALUES ('default', $1, $2, $3)`,
                    [activeProfileId, DEFAULT_VOICE_MODE, nowStr]
                );
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
                const nowStr = new Date().toISOString();
                for (const profileId of ['classic', 'warm_guide']) {
                    await client.query(
                        `INSERT INTO persona_profile_settings (profile_id, overrides_json, created_at, updated_at)
                         VALUES ($1, '{}', $2, $2) ON CONFLICT DO NOTHING`,
                        [profileId, nowStr]
                    );
                }
            }

            const activeState = (await client.query(
                "SELECT active_profile_id, voice_mode, session_limit_minutes, session_limit_minutes_kiosk, session_limit_minutes_mobile_qr FROM persona_active_state WHERE state_key = 'default'"
            )).rows[0];
            const profilesRows = (await client.query('SELECT profile_id, overrides_json FROM persona_profile_settings')).rows;
            await client.query('COMMIT');

            const profiles = {};
            for (const row of profilesRows) {
                const raw = typeof row.overrides_json === 'object' ? row.overrides_json : JSON.parse(row.overrides_json || '{}');
                profiles[row.profile_id] = { overrides: cleanLoadedOverrides(raw) };
            }
            if (!profiles.classic) profiles.classic = { overrides: {} };
            if (!profiles.warm_guide) profiles.warm_guide = { overrides: {} };
            cache = {
                activeProfileId: activeState?.active_profile_id || 'classic',
                voiceMode: ALLOWED_VOICE_MODES.includes(activeState?.voice_mode) ? activeState.voice_mode : DEFAULT_VOICE_MODE,
                sessionLimitMinutes: ALLOWED_SESSION_LIMIT_MINUTES.includes(Number(activeState?.session_limit_minutes))
                    ? Number(activeState.session_limit_minutes)
                    : DEFAULT_SESSION_LIMIT_MINUTES,
                sessionLimitMinutesByContext: {
                    kiosk: ALLOWED_SESSION_LIMIT_MINUTES.includes(Number(activeState?.session_limit_minutes_kiosk)) ? Number(activeState.session_limit_minutes_kiosk) : null,
                    mobile_qr: ALLOWED_SESSION_LIMIT_MINUTES.includes(Number(activeState?.session_limit_minutes_mobile_qr)) ? Number(activeState.session_limit_minutes_mobile_qr) : null,
                },
                profiles
            };
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch {}
            loadError = err;
            console.error('[WineAI] Database migration failed. Raising Service Unavailable:', err);
            throw err;
        } finally {
            client.release();
        }
    } else {
        try {
            if (!fs.existsSync(FILE_PATH)) {
                cache = defaultCache();
                return getCached();
            }
            const raw = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8')) || {};
            const sessionLimitMinutes = ALLOWED_SESSION_LIMIT_MINUTES.includes(Number(raw.sessionLimitMinutes))
                ? Number(raw.sessionLimitMinutes)
                : DEFAULT_SESSION_LIMIT_MINUTES;
            const sessionLimitMinutesByContext = {
                kiosk: ALLOWED_SESSION_LIMIT_MINUTES.includes(Number(raw.sessionLimitMinutesByContext?.kiosk)) ? Number(raw.sessionLimitMinutesByContext.kiosk) : null,
                mobile_qr: ALLOWED_SESSION_LIMIT_MINUTES.includes(Number(raw.sessionLimitMinutesByContext?.mobile_qr)) ? Number(raw.sessionLimitMinutesByContext.mobile_qr) : null,
            };
            if (raw.profiles === undefined && (raw.baseProfileId !== undefined || raw.overrides !== undefined)) {
                console.log('[WineAI] Performing legacy JSON to profile-scoped settings migration...');
                const activeProfileId = raw.baseProfileId || 'classic';
                const oldOverrides = cleanLoadedOverrides(raw.overrides || {});
                if (!oldOverrides.mood && raw.mood) oldOverrides.mood = raw.mood;
                cache = {
                    activeProfileId,
                    voiceMode: ALLOWED_VOICE_MODES.includes(raw.voiceMode) ? raw.voiceMode : DEFAULT_VOICE_MODE,
                    sessionLimitMinutes,
                    sessionLimitMinutesByContext,
                    profiles: {
                        classic: activeProfileId === 'classic' ? { overrides: oldOverrides } : { overrides: {} },
                        warm_guide: activeProfileId === 'warm_guide' ? { overrides: oldOverrides } : { overrides: {} }
                    }
                };
            } else {
                cache = {
                    activeProfileId: raw.activeProfileId || 'classic',
                    voiceMode: ALLOWED_VOICE_MODES.includes(raw.voiceMode) ? raw.voiceMode : DEFAULT_VOICE_MODE,
                    sessionLimitMinutes,
                    sessionLimitMinutesByContext,
                    profiles: {
                        classic: { overrides: cleanLoadedOverrides(raw.profiles?.classic?.overrides || {}) },
                        warm_guide: { overrides: cleanLoadedOverrides(raw.profiles?.warm_guide?.overrides || {}) }
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

function getLoadError() { return loadError; }
function getActiveProfileId() { return cache.activeProfileId; }
function getProfilesOverrides() { return cache.profiles; }

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

function getActiveProfile() { return getProfile(cache.activeProfileId); }

function getCached() {
    const activeProfileId = cache.activeProfileId;
    const builtin = getProfileById(activeProfileId);
    const rawOverrides = cache.profiles[activeProfileId]?.overrides || {};
    const hasMeaningfulOverrides = Object.keys(rawOverrides).some((key) => {
        if (key === 'mood') return false;
        if (['style', 'runtimeByProvider', 'identity', 'startIntents'].includes(key)) return Object.keys(rawOverrides[key] || {}).length > 0;
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
        sessionLimitMinutes: ALLOWED_SESSION_LIMIT_MINUTES.includes(cache.sessionLimitMinutes) ? cache.sessionLimitMinutes : DEFAULT_SESSION_LIMIT_MINUTES,
        sessionLimitMinutesByContext: {
            kiosk: ALLOWED_SESSION_LIMIT_MINUTES.includes(cache.sessionLimitMinutesByContext?.kiosk) ? cache.sessionLimitMinutesByContext.kiosk : null,
            mobile_qr: ALLOWED_SESSION_LIMIT_MINUTES.includes(cache.sessionLimitMinutesByContext?.mobile_qr) ? cache.sessionLimitMinutesByContext.mobile_qr : null,
        },
        overrides
    };
}

function validateStartIntents(value) {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        const err = new Error('startIntents must be an object');
        err.statusCode = 400;
        throw err;
    }
    const clean = {};
    for (const [lang, intents] of Object.entries(value)) {
        if (!START_INTENT_LANGUAGES.includes(lang)) {
            const err = new Error(`invalid_start_intent_language: ${lang}`);
            err.statusCode = 400;
            throw err;
        }
        if (!intents || typeof intents !== 'object' || Array.isArray(intents)) {
            const err = new Error(`invalid_start_intent_language_block: ${lang}`);
            err.statusCode = 400;
            throw err;
        }
        const langBlock = {};
        for (const [intentId, config] of Object.entries(intents)) {
            if (!START_INTENT_IDS.includes(intentId)) {
                const err = new Error(`invalid_start_intent_id: ${intentId}`);
                err.statusCode = 400;
                throw err;
            }
            if (!config || typeof config !== 'object' || Array.isArray(config)) {
                const err = new Error(`invalid_start_intent_config: ${intentId}`);
                err.statusCode = 400;
                throw err;
            }
            const allowedFields = ['label', 'openingLine', 'context', 'enabled'];
            for (const field of Object.keys(config)) {
                if (!allowedFields.includes(field)) {
                    const err = new Error(`invalid_start_intent_field: ${field}`);
                    err.statusCode = 400;
                    throw err;
                }
            }
            const row = {};
            if (config.label !== undefined) {
                if (typeof config.label !== 'string') throw Object.assign(new Error('start_intent_label_must_be_string'), { statusCode: 400 });
                row.label = config.label.trim().slice(0, 80);
            }
            if (config.openingLine !== undefined) {
                if (typeof config.openingLine !== 'string') throw Object.assign(new Error('start_intent_opening_line_must_be_string'), { statusCode: 400 });
                row.openingLine = config.openingLine.trim().slice(0, 500);
            }
            if (config.context !== undefined) {
                if (typeof config.context !== 'string') throw Object.assign(new Error('start_intent_context_must_be_string'), { statusCode: 400 });
                row.context = config.context.trim().slice(0, 3000);
            }
            if (config.enabled !== undefined) {
                if (typeof config.enabled !== 'boolean') throw Object.assign(new Error('start_intent_enabled_must_be_boolean'), { statusCode: 400 });
                row.enabled = config.enabled;
            }
            if (Object.keys(row).length) langBlock[intentId] = row;
        }
        if (Object.keys(langBlock).length) clean[lang] = langBlock;
    }
    if (JSON.stringify(clean).length > 50000) {
        const err = new Error('start_intents_too_large');
        err.statusCode = 400;
        throw err;
    }
    return clean;
}

function validateAndMergeOverrides(current, patch) {
    const overrides = JSON.parse(JSON.stringify(current || {}));
    if (!patch) return overrides;
    const allowedKeys = ['name', 'description', 'welcomeMessage', 'sommelierGender', 'systemPrompt', 'personalityPrompt', 'mood', 'style', 'runtimeByProvider', 'identity', 'startIntents'];
    for (const key of Object.keys(patch)) {
        if (!allowedKeys.includes(key)) {
            const err = new Error('unsupported_override_field');
            err.statusCode = 400;
            throw err;
        }
    }

    for (const key of ['name', 'description', 'welcomeMessage', 'systemPrompt', 'personalityPrompt', 'mood']) {
        if (patch[key] === undefined) continue;
        const val = patch[key];
        if (val === null) {
            delete overrides[key];
        } else if (typeof val === 'string') {
            if (key === 'mood') {
                if (!['calm', 'warm', 'lively', 'expert'].includes(val)) throw Object.assign(new Error('invalid_mood'), { statusCode: 400 });
                overrides.mood = val;
            } else {
                const limit = { name: 80, description: 400, welcomeMessage: 600, systemPrompt: 24000, personalityPrompt: 24000 }[key];
                overrides[key] = val.trim().slice(0, limit);
            }
        } else {
            throw Object.assign(new Error(`Invalid type for field ${key}`), { statusCode: 400 });
        }
    }

    if (patch.sommelierGender !== undefined) {
        if (typeof patch.sommelierGender !== 'string' || !ALLOWED_GENDERS.includes(patch.sommelierGender)) throw Object.assign(new Error('invalid_sommelier_gender'), { statusCode: 400 });
        overrides.sommelierGender = patch.sommelierGender;
    }

    if (patch.style !== undefined) {
        if (patch.style === null) {
            delete overrides.style;
        } else {
            if (typeof patch.style !== 'object' || Array.isArray(patch.style)) throw Object.assign(new Error('style must be an object'), { statusCode: 400 });
            if (!overrides.style) overrides.style = {};
            const allowedStyleKeys = ['responseLength', 'humorLevel', 'tone', 'expertiseLevel', 'storytelling', 'proactiveSuggestions', 'toastStyle', 'conversationMode', 'askFollowUpQuestions', 'useHumor', 'talkAboutSelf', 'supportSmallTalk', 'softlyReturnToWine', 'useFictionalBiography', 'responseVariety'];
            const boolKeys = ['proactiveSuggestions', 'askFollowUpQuestions', 'useHumor', 'talkAboutSelf', 'supportSmallTalk', 'softlyReturnToWine', 'useFictionalBiography'];
            for (const [key, val] of Object.entries(patch.style)) {
                if (!allowedStyleKeys.includes(key)) throw Object.assign(new Error(`Unknown style field: ${key}`), { statusCode: 400 });
                if (val === null) delete overrides.style[key];
                else if (boolKeys.includes(key)) {
                    if (typeof val !== 'boolean') throw Object.assign(new Error(`${key} must be a boolean`), { statusCode: 400 });
                    overrides.style[key] = val;
                } else if (key === 'responseLength') {
                    if (typeof val !== 'string' || !['brief', 'balanced', 'detailed', 'short'].includes(val)) throw Object.assign(new Error('invalid_response_length'), { statusCode: 400 });
                    overrides.style[key] = val;
                } else if (key === 'responseVariety') {
                    if (typeof val !== 'string' || !['stable', 'natural', 'expressive'].includes(val)) throw Object.assign(new Error('invalid_response_variety'), { statusCode: 400 });
                    overrides.style[key] = val;
                } else if (key === 'conversationMode') {
                    if (typeof val !== 'string' || !['strict', 'friendly', 'free'].includes(val)) throw Object.assign(new Error('invalid_conversation_mode'), { statusCode: 400 });
                    overrides.style[key] = val;
                } else {
                    if (typeof val !== 'string') throw Object.assign(new Error(`${key} must be a string`), { statusCode: 400 });
                    overrides.style[key] = val.trim().slice(0, 200);
                }
            }
            if (!Object.keys(overrides.style).length) delete overrides.style;
        }
    }

    if (patch.runtimeByProvider !== undefined) {
        if (patch.runtimeByProvider === null) {
            delete overrides.runtimeByProvider;
        } else {
            if (typeof patch.runtimeByProvider !== 'object' || Array.isArray(patch.runtimeByProvider)) throw Object.assign(new Error('runtimeByProvider must be an object'), { statusCode: 400 });
            if (!overrides.runtimeByProvider) overrides.runtimeByProvider = {};
            for (const [providerId, providerBlock] of Object.entries(patch.runtimeByProvider)) {
                if (!['gemini', 'grok'].includes(providerId)) {
                    const errCode = providerId === 'mock' ? 'unsupported_provider_capability' : 'unknown_provider';
                    throw Object.assign(new Error(errCode), { statusCode: 400 });
                }
                if (providerBlock === null) {
                    delete overrides.runtimeByProvider[providerId];
                    continue;
                }
                if (typeof providerBlock !== 'object' || Array.isArray(providerBlock)) throw Object.assign(new Error(`${providerId} block must be an object`), { statusCode: 400 });
                if (!overrides.runtimeByProvider[providerId]) overrides.runtimeByProvider[providerId] = {};
                for (const [key, val] of Object.entries(providerBlock)) {
                    if (key !== 'voiceId') throw Object.assign(new Error('unsupported_runtime_field'), { statusCode: 400 });
                    if (val === null) {
                        delete overrides.runtimeByProvider[providerId][key];
                        continue;
                    }
                    if (typeof val !== 'string') throw Object.assign(new Error(`${key} must be a string`), { statusCode: 400 });
                    if (providerId === 'gemini') {
                        const { GEMINI_VOICE_NAMES } = require('../geminiVoices');
                        if (!GEMINI_VOICE_NAMES.includes(val)) throw Object.assign(new Error('invalid_voice_id'), { statusCode: 400 });
                    } else {
                        const { GROK_VOICES } = require('../grokVoices');
                        if (!GROK_VOICES.some(v => v.id === val || v.name === val || v.name.toLowerCase() === val.toLowerCase())) throw Object.assign(new Error('invalid_voice_id'), { statusCode: 400 });
                    }
                    overrides.runtimeByProvider[providerId][key] = val;
                }
                if (!Object.keys(overrides.runtimeByProvider[providerId]).length) delete overrides.runtimeByProvider[providerId];
            }
            if (!Object.keys(overrides.runtimeByProvider).length) delete overrides.runtimeByProvider;
        }
    }

    if (patch.identity !== undefined) {
        if (patch.identity === null) {
            delete overrides.identity;
        } else {
            if (typeof patch.identity !== 'object' || Array.isArray(patch.identity)) throw Object.assign(new Error('identity must be an object'), { statusCode: 400 });
            if (!overrides.identity) overrides.identity = {};
            const allowedIdentityKeys = ['background', 'creatorDescription', 'roleDescription', 'selfAdvantages', 'selfLimitations', 'wineAffinity', 'interests'];
            for (const [key, val] of Object.entries(patch.identity)) {
                if (!allowedIdentityKeys.includes(key)) throw Object.assign(new Error(`Unknown identity field: ${key}`), { statusCode: 400 });
                if (val === null) {
                    delete overrides.identity[key];
                } else if (key === 'interests') {
                    if (!Array.isArray(val) || val.length > 15 || val.some(item => typeof item !== 'string')) throw Object.assign(new Error('invalid_interests'), { statusCode: 400 });
                    overrides.identity[key] = val.map(item => item.trim().slice(0, 60)).filter(Boolean);
                } else {
                    if (typeof val !== 'string') throw Object.assign(new Error(`${key} must be a string`), { statusCode: 400 });
                    overrides.identity[key] = val.trim().slice(0, 2000);
                }
            }
            if (!Object.keys(overrides.identity).length) delete overrides.identity;
        }
    }

    if (patch.startIntents !== undefined) {
        const clean = validateStartIntents(patch.startIntents);
        if (clean === null || !Object.keys(clean).length) delete overrides.startIntents;
        else overrides.startIntents = clean;
    }

    return overrides;
}

function writeFileCache() {
    fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
    const tmpPath = FILE_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmpPath, FILE_PATH);
}

async function updateProfile(profileId, patch) {
    if (!getProfileById(profileId)) throw Object.assign(new Error(`invalid_profile_id: ${profileId}`), { statusCode: 400 });
    if (db.isEnabled()) {
        const client = await db.getPool().connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query('SELECT overrides_json FROM persona_profile_settings WHERE profile_id = $1 FOR UPDATE', [profileId]);
            if (!rows.length) throw new Error(`Profile row ${profileId} not found in database`);
            const merged = validateAndMergeOverrides(rows[0].overrides_json || {}, patch);
            await client.query(
                `UPDATE persona_profile_settings SET overrides_json = $1, updated_at = $2 WHERE profile_id = $3`,
                [JSON.stringify(merged), new Date().toISOString(), profileId]
            );
            await client.query('COMMIT');
            cache.profiles[profileId] = { overrides: merged };
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch {}
            console.error(`[WineAI] updateProfile transaction failed for ${profileId}:`, err);
            throw err;
        } finally {
            client.release();
        }
    } else {
        const current = cache.profiles[profileId]?.overrides || {};
        cache.profiles[profileId] = { overrides: validateAndMergeOverrides(current, patch) };
        writeFileCache();
    }
    return getProfile(profileId);
}

async function resetProfile(profileId) {
    if (!getProfileById(profileId)) throw Object.assign(new Error(`invalid_profile_id: ${profileId}`), { statusCode: 400 });
    if (db.isEnabled()) {
        const client = await db.getPool().connect();
        try {
            await client.query('BEGIN');
            await client.query(`UPDATE persona_profile_settings SET overrides_json = '{}', updated_at = $1 WHERE profile_id = $2`, [new Date().toISOString(), profileId]);
            await client.query('COMMIT');
            cache.profiles[profileId] = { overrides: {} };
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch {}
            console.error(`[WineAI] resetProfile transaction failed for ${profileId}:`, err);
            throw err;
        } finally {
            client.release();
        }
    } else {
        cache.profiles[profileId] = { overrides: {} };
        writeFileCache();
    }
    return getProfile(profileId);
}

async function activateProfile(profileId) {
    if (!getProfileById(profileId)) throw Object.assign(new Error(`invalid_profile_id: ${profileId}`), { statusCode: 400 });
    if (db.isEnabled()) {
        const client = await db.getPool().connect();
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
            try { await client.query('ROLLBACK'); } catch {}
            console.error('[WineAI] activateProfile transaction failed:', err);
            throw err;
        } finally {
            client.release();
        }
    } else {
        cache.activeProfileId = profileId;
        writeFileCache();
    }
    return getProfile(profileId);
}

function getVoiceMode() {
    return ALLOWED_VOICE_MODES.includes(cache.voiceMode) ? cache.voiceMode : DEFAULT_VOICE_MODE;
}

async function setVoiceMode(mode) {
    if (!ALLOWED_VOICE_MODES.includes(mode)) throw Object.assign(new Error('invalid_voice_mode'), { statusCode: 400 });
    if (db.isEnabled()) {
        await db.getPool().query(
            `INSERT INTO persona_active_state (state_key, active_profile_id, voice_mode, updated_at)
             VALUES ('default', $1, $2, $3)
             ON CONFLICT (state_key) DO UPDATE SET voice_mode = EXCLUDED.voice_mode, updated_at = EXCLUDED.updated_at`,
            [cache.activeProfileId, mode, new Date().toISOString()]
        );
    }
    cache.voiceMode = mode;
    if (!db.isEnabled()) writeFileCache();
    return getCached();
}

function getSessionLimitMinutes(context) {
    const general = ALLOWED_SESSION_LIMIT_MINUTES.includes(cache.sessionLimitMinutes) ? cache.sessionLimitMinutes : DEFAULT_SESSION_LIMIT_MINUTES;
    if (context && SESSION_LIMIT_CONTEXTS.includes(context)) {
        const override = cache.sessionLimitMinutesByContext?.[context];
        if (ALLOWED_SESSION_LIMIT_MINUTES.includes(override)) return override;
    }
    return general;
}

async function setSessionLimitMinutes(minutes) {
    const value = Number(minutes);
    if (!ALLOWED_SESSION_LIMIT_MINUTES.includes(value)) throw Object.assign(new Error('invalid_session_limit_minutes'), { statusCode: 400 });
    if (db.isEnabled()) {
        await db.getPool().query(
            `INSERT INTO persona_active_state (state_key, active_profile_id, session_limit_minutes, updated_at)
             VALUES ('default', $1, $2, $3)
             ON CONFLICT (state_key) DO UPDATE SET session_limit_minutes = EXCLUDED.session_limit_minutes, updated_at = EXCLUDED.updated_at`,
            [cache.activeProfileId, value, new Date().toISOString()]
        );
    }
    cache.sessionLimitMinutes = value;
    if (!db.isEnabled()) writeFileCache();
    return getCached();
}

async function setSessionLimitMinutesForContext(context, value) {
    if (!SESSION_LIMIT_CONTEXTS.includes(context)) throw Object.assign(new Error('invalid_session_limit_context'), { statusCode: 400 });
    const normalized = value === null || value === undefined ? null : Number(value);
    if (normalized !== null && !ALLOWED_SESSION_LIMIT_MINUTES.includes(normalized)) throw Object.assign(new Error('invalid_session_limit_minutes'), { statusCode: 400 });
    const column = context === 'kiosk' ? 'session_limit_minutes_kiosk' : 'session_limit_minutes_mobile_qr';
    if (db.isEnabled()) {
        await db.getPool().query(
            `INSERT INTO persona_active_state (state_key, active_profile_id, ${column}, updated_at)
             VALUES ('default', $1, $2, $3)
             ON CONFLICT (state_key) DO UPDATE SET ${column} = EXCLUDED.${column}, updated_at = EXCLUDED.updated_at`,
            [cache.activeProfileId, normalized, new Date().toISOString()]
        );
    }
    cache.sessionLimitMinutesByContext = { ...cache.sessionLimitMinutesByContext, [context]: normalized };
    if (!db.isEnabled()) writeFileCache();
    return getCached();
}

function setLegacyCustomProfile(value) { legacyCustomProfile = Boolean(value); }
function isLegacyCustomProfile() { return legacyCustomProfile; }

async function save(body = {}) {
    if (body.voiceMode !== undefined) await setVoiceMode(body.voiceMode);
    if (body.sessionLimitMinutes !== undefined) await setSessionLimitMinutes(body.sessionLimitMinutes);
    if (body.sessionLimitMinutesByContext && typeof body.sessionLimitMinutesByContext === 'object') {
        for (const context of SESSION_LIMIT_CONTEXTS) {
            if (Object.prototype.hasOwnProperty.call(body.sessionLimitMinutesByContext, context)) {
                await setSessionLimitMinutesForContext(context, body.sessionLimitMinutesByContext[context]);
            }
        }
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
            if (activeMood && activeMood !== 'calm') await updateProfile(body.baseProfileId, { mood: activeMood });
        }
    }
    if (body.reset) {
        if (isLegacyCustomProfile()) throw Object.assign(new Error('Cannot reset a custom profile'), { statusCode: 400 });
        await resetProfile(cache.activeProfileId);
        return getCached();
    }
    const patch = { ...(body.overrides || {}) };
    const flatKeys = ['name', 'description', 'welcomeMessage', 'sommelierGender', 'personalityPrompt', 'systemPrompt', 'mood', 'style', 'runtimeByProvider', 'identity', 'startIntents'];
    for (const key of Object.keys(body)) if (flatKeys.includes(key)) patch[key] = body[key];
    if (Object.keys(patch).length) await updateProfile(cache.activeProfileId, patch);
    return getCached();
}

function listProfileStates() {
    return Object.keys(cache.profiles).map((id) => ({
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
    getSessionLimitMinutes,
    setSessionLimitMinutes,
    setSessionLimitMinutesForContext,
    DEFAULT_SOMMELIER_GENDER,
    DEFAULT_VOICE_MODE,
    ALLOWED_GENDERS,
    ALLOWED_VOICE_MODES,
    ALLOWED_SESSION_LIMIT_MINUTES,
    DEFAULT_SESSION_LIMIT_MINUTES,
    SESSION_LIMIT_CONTEXTS
};
