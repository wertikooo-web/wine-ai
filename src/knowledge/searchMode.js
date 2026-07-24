'use strict';

// Runtime-toggleable knowledge search mode — deliberately NOT an env var
// requiring a redeploy: the point (per the project owner) is to flip this
// live from the Dashboard and compare keyword-only vs hybrid results on
// the same running server. In-memory only (resets on redeploy/restart),
// which is fine — this is a comparison/testing knob, not durable config.
// Starts on 'keyword' (the previously-only mode) so enabling semantic
// search is always an explicit opt-in, never a silent behavior change.
const VALID_MODES = new Set(['keyword', 'hybrid']);
let currentMode = 'keyword';

function getMode() {
    return currentMode;
}

function setMode(mode) {
    if (!VALID_MODES.has(mode)) {
        const error = new Error(`invalid_search_mode: ${mode}`);
        error.code = 'invalid_search_mode';
        throw error;
    }
    currentMode = mode;
    return currentMode;
}

module.exports = { getMode, setMode, VALID_MODES: [...VALID_MODES] };
