'use strict';

// Central place to read process.env once, with defaults — see .env.example
// for the full annotated list. Anything not listed here is read directly
// where it's used (transport-level tuning knobs like PTT_TURN_TIMEOUT_MS
// stay next to the code they tune, per the origin project's own
// convention — see docs/WINE_AI_MIGRATION_PLAN.md section 1.18).

const PORT = Number(process.env.PORT || 3200);
const REALTIME_PROVIDER = process.env.REALTIME_PROVIDER || 'mock';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const AVATAR_PROVIDER = process.env.AVATAR_PROVIDER || 'mock';
const DEFAULT_LANGUAGE = process.env.DEFAULT_LANGUAGE || 'auto';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const SAVE_AUDIO = /^(1|true|yes|on)$/i.test(String(process.env.SAVE_AUDIO || ''));

module.exports = {
    PORT,
    REALTIME_PROVIDER,
    GEMINI_API_KEY,
    AVATAR_PROVIDER,
    DEFAULT_LANGUAGE,
    LOG_LEVEL,
    SAVE_AUDIO,
};
