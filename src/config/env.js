'use strict';

// Central place to read process.env once, with defaults — see .env.example
// for the full annotated list. Anything not listed here is read directly
// where it's used (transport-level tuning knobs like PTT_TURN_TIMEOUT_MS
// stay next to the code they tune, per the origin project's own
// convention — see docs/WINE_AI_MIGRATION_PLAN.md section 1.18).

const PORT = Number(process.env.PORT || 3200);
const REALTIME_PROVIDER = process.env.REALTIME_PROVIDER || 'mock';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GROK_API_KEY = process.env.GROK_API_KEY || process.env.XAI_API_KEY || '';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const AVATAR_PROVIDER = process.env.AVATAR_PROVIDER || 'mock';
const DEFAULT_LANGUAGE = process.env.DEFAULT_LANGUAGE || 'auto';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const SAVE_AUDIO = /^(1|true|yes|on)$/i.test(String(process.env.SAVE_AUDIO || ''));

// Admin auth — at least one of ADMIN_PASSWORD or ADMIN_TOKEN must be set
// in production. Both are optional in local dev (auth is disabled when
// neither is set).
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 24 * 60 * 60 * 1000);
const COOKIE_SECRET = process.env.COOKIE_SECRET || '';

module.exports = {
    PORT,
    REALTIME_PROVIDER,
    GEMINI_API_KEY,
    GROK_API_KEY,
    DEEPGRAM_API_KEY,
    AVATAR_PROVIDER,
    DEFAULT_LANGUAGE,
    LOG_LEVEL,
    SAVE_AUDIO,
    get REALTIME_ALLOW_LEGACY_VOICE_OVERRIDE() {
        return process.env.REALTIME_ALLOW_LEGACY_VOICE_OVERRIDE !== undefined
            ? /^(1|true|yes|on)$/i.test(String(process.env.REALTIME_ALLOW_LEGACY_VOICE_OVERRIDE))
            : true;
    },
    ADMIN_PASSWORD,
    ADMIN_TOKEN,
    SESSION_TTL_MS,
    COOKIE_SECRET,
};
