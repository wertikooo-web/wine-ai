'use strict';

// Last few knowledge-search timings (numbers and stage names only -- no query
// text), shown in /health so production latency can be checked without log
// access. In-memory, bounded.

const MAX_ENTRIES = 20;
const entries = [];

function recordKnowledgeTiming(entry) {
    try {
        entries.push({ at: new Date().toISOString(), ...entry });
        while (entries.length > MAX_ENTRIES) entries.shift();
    } catch { /* never affects the search */ }
}

function recentKnowledgeTimings() {
    return entries.slice(-10);
}

module.exports = { recordKnowledgeTiming, recentKnowledgeTimings };
