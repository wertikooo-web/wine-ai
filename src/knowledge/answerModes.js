'use strict';

// Answer modes (docs/architecture/WINE_KNOWLEDGE_STRATEGY_AND_ROADMAP.md §4).
//
// A mode declares WHICH knowledge levels the orchestrator may consult and
// whether explicit AI inference is permitted. Modes are a retrieval/synthesis
// contract, not a persona mood — the four persona moods (calm/warm/lively/
// expert) live in src/persona/profileRegistry.js and are orthogonal.
//
// Default production mode is 'knowledge_web': canonical facts, Wine.md
// catalog, approved documents, and controlled web fallback.

const KNOWLEDGE_LEVELS = Object.freeze(['canonical', 'catalog', 'documents', 'web']);

const ANSWER_MODES = Object.freeze({
    KNOWLEDGE_ONLY: 'knowledge_only',
    KNOWLEDGE_CATALOG: 'knowledge_catalog',
    KNOWLEDGE_WEB: 'knowledge_web',
    EXPERT: 'expert',
});

const DEFAULT_ANSWER_MODE = ANSWER_MODES.KNOWLEDGE_WEB;

// Per-mode allowed levels and behavior. A mode declares WHICH knowledge
// levels may be consulted. Explicit AI inference (recommendations, pairings,
// comparisons, route planning) is gated by Phase 6 INTENT detection at
// runtime, not by answer_mode -- it runs on the ordinary user path whenever
// the question is a recommendation/pairing/comparison/route ask, and never on
// plain factual turns. `allowInference` below remains the mode's declared
// inference capability (used by the admin listing and the audit `no_inference`
// constraint); it is not the runtime gate.
const MODE_POLICY = Object.freeze({
    [ANSWER_MODES.KNOWLEDGE_ONLY]: {
        id: ANSWER_MODES.KNOWLEDGE_ONLY,
        label: 'knowledge_only — canonical facts + approved documents only',
        levels: Object.freeze(['canonical', 'documents']),
        allowCatalog: false,
        allowWeb: false,
        allowInference: false,
    },
    [ANSWER_MODES.KNOWLEDGE_CATALOG]: {
        id: ANSWER_MODES.KNOWLEDGE_CATALOG,
        label: 'knowledge_catalog — canonical + documents + Wine.md live catalog',
        levels: Object.freeze(['canonical', 'catalog', 'documents']),
        allowCatalog: true,
        allowWeb: false,
        allowInference: false,
    },
    [ANSWER_MODES.KNOWLEDGE_WEB]: {
        id: ANSWER_MODES.KNOWLEDGE_WEB,
        label: 'knowledge_web — canonical + catalog + documents + controlled web fallback',
        levels: Object.freeze(['canonical', 'catalog', 'documents', 'web']),
        allowCatalog: true,
        allowWeb: true,
        allowInference: false,
    },
    [ANSWER_MODES.EXPERT]: {
        id: ANSWER_MODES.EXPERT,
        label: 'expert — all approved levels + explicit AI inference',
        levels: Object.freeze(['canonical', 'catalog', 'documents', 'web']),
        allowCatalog: true,
        allowWeb: true,
        allowInference: true,
    },
});

function isAnswerMode(value) {
    return Object.prototype.hasOwnProperty.call(MODE_POLICY, String(value || ''));
}

// Returns null when the input is not a known mode, so callers can decide
// whether to reject (strict config) or fall back (default).
function normalizeAnswerMode(value) {
    if (isAnswerMode(value)) return String(value);
    return null;
}

// The orchestrator's effective mode: unknown/absent → default (knowledge_web).
function resolveAnswerMode(value) {
    return normalizeAnswerMode(value) || DEFAULT_ANSWER_MODE;
}

function modePolicy(mode) {
    return MODE_POLICY[resolveAnswerMode(mode)] || MODE_POLICY[DEFAULT_ANSWER_MODE];
}

// Strip an evidence list down to the levels this mode allows, preserving the
// existing (already level-ranked) order. Levels the mode never uses — e.g.
// web in knowledge_only — are dropped before classification, so a claim about
// price can never silently fall back to a web price when catalog is disabled.
function filterLevelsByMode(evidence, mode) {
    const policy = modePolicy(mode);
    const allowed = new Set(policy.levels);
    return Array.isArray(evidence) ? evidence.filter((item) => allowed.has(item.level)) : [];
}

function listAnswerModes() {
    return Object.values(ANSWER_MODES).map((mode) => ({
        mode,
        levels: MODE_POLICY[mode].levels,
        allowCatalog: MODE_POLICY[mode].allowCatalog,
        allowWeb: MODE_POLICY[mode].allowWeb,
        allowInference: MODE_POLICY[mode].allowInference,
    }));
}

module.exports = {
    ANSWER_MODES,
    KNOWLEDGE_LEVELS,
    DEFAULT_ANSWER_MODE,
    MODE_POLICY,
    isAnswerMode,
    normalizeAnswerMode,
    resolveAnswerMode,
    modePolicy,
    filterLevelsByMode,
    listAnswerModes,
};