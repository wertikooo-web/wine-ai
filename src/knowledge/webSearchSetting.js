'use strict';

// Runtime read of the Dashboard "knowledge source" switch
// (cost_settings.web_search_enabled): true = our knowledge base first, the
// internet only when it has no answer; false = knowledge base only.
//
// Read on the voice hot path, so it is synchronous and never waits on the
// database: it returns the last known value (default: enabled) and refreshes
// it in the background at most every REFRESH_MS. A failed refresh keeps the
// last value. The settings API calls setWebSearchEnabled() after a save so
// the change applies immediately in this process.

const REFRESH_MS = 15000;

let cached = true;
let fetchedAt = 0;
let inFlight = null;

function refresh() {
    if (inFlight) return inFlight;
    fetchedAt = Date.now();
    inFlight = (async () => {
        try {
            const { getCostStore } = require('../cost/costStore');
            const settings = await getCostStore().getSettings();
            cached = settings.web_search_enabled !== false;
        } catch {
            // keep the last known value
        } finally {
            inFlight = null;
        }
    })();
    return inFlight;
}

function isWebSearchEnabled() {
    if (Date.now() - fetchedAt > REFRESH_MS) refresh();
    return cached;
}

function setWebSearchEnabled(value) {
    cached = value !== false;
    fetchedAt = Date.now();
}

function resetWebSearchSettingForTests() {
    cached = true;
    fetchedAt = 0;
    inFlight = null;
}

module.exports = { isWebSearchEnabled, setWebSearchEnabled, refreshWebSearchSetting: refresh, resetWebSearchSettingForTests };
