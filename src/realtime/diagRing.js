'use strict';

// In-memory ring of recent realtime diagnostics for the admin
// (GET /api/diag/realtime-events): which Gemini connections were opened with
// which speech languageCode, and when the conversation language switched.
// Observation only; nothing reads it back into the conversation.

const MAX_ENTRIES = 200;
const entries = [];

function push(type, data = {}) {
    entries.push({ at: new Date().toISOString(), type, ...data });
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

function recent(limit = MAX_ENTRIES) {
    return entries.slice(-Math.max(1, Math.min(MAX_ENTRIES, Number(limit) || MAX_ENTRIES)));
}

module.exports = { push, recent };
