'use strict';

// Answer Audit (Phase 2).
//
// Runs the Phase 1 orchestrator over a question in one or all answer modes,
// measures latency per mode, attaches auditMetrics() to each mode result, and
// returns a self-contained audit record that the admin screen renders and the
// benchmark scores. Reuses orchestrateKnowledge() + claim provenance -- it
// does not build a second answer system.

const { orchestrateKnowledge } = require('./knowledgeOrchestrator');
const { listAnswerModes, ANSWER_MODES } = require('./answerModes');
const { auditMetrics } = require('./auditMetrics');

const DEFAULT_MODES = [ANSWER_MODES.KNOWLEDGE_ONLY, ANSWER_MODES.KNOWLEDGE_CATALOG, ANSWER_MODES.KNOWLEDGE_WEB, ANSWER_MODES.EXPERT];

const SUPPORTED_CONSTRAINTS = Object.freeze(['no_prices', 'no_web', 'no_catalog', 'no_inference']);

function normalizeConstraints(raw) {
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    return [...new Set(list.map((value) => String(value).trim()).filter((value) => SUPPORTED_CONSTRAINTS.includes(value)))];
}

function normalizeQuestion(question) {
    const text = String(question || '').trim();
    if (!text) throw Object.assign(new Error('question_required'), { code: 'question_required' });
    if (text.length > 1000) throw Object.assign(new Error('question_too_long'), { code: 'question_too_long' });
    return text;
}

function normalizeLanguage(language) {
    return ['ru', 'ro', 'en'].includes(language) ? language : null;
}

// One owned request per mode; measure wall latency inside the request so the
// number reflects exactly what that mode cost (retrieval + checks), not the
// caller loop overhead.
async function runMode(question, { language, mode, constraints, routeImpl }) {
    const startedAt = process.hrtime.bigint();
    const result = await orchestrateKnowledge(question, {
        language,
        answerMode: mode,
        routeImpl,
        constraints,
    });
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const metrics = auditMetrics({
        ...result,
        constraints,
    });
    return {
        answer_mode: mode,
        latency_ms: Number(latencyMs.toFixed(1)),
        ...result,
        metrics,
    };
}

async function runAnswerAudit({ question, language = null, modes = null, constraints = null, routeImpl = null } = {}) {
    const normalizedQuestion = normalizeQuestion(question);
    const normalizedLanguage = normalizeLanguage(language);
    const constraintList = normalizeConstraints(constraints);
    const modeList = Array.isArray(modes) && modes.length
        ? modes.filter((m) => listAnswerModes().some((entry) => entry.mode === m))
        : DEFAULT_MODES.slice();
    if (!modeList.length) modeList.push(ANSWER_MODES.KNOWLEDGE_WEB);

    const startedAt = process.hrtime.bigint();
    const results = [];
    for (const mode of modeList) {
        const run = await runMode(normalizedQuestion, {
            language: normalizedLanguage,
            mode,
            constraints: constraintList,
            routeImpl,
        });
        results.push(run);
    }
    const totalLatencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    return {
        id: `audit_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        created_at: new Date().toISOString(),
        question: normalizedQuestion,
        language: normalizedLanguage || 'auto',
        answer_mode: modeList.length === 1 ? modeList[0] : 'all',
        modes: modeList,
        constraints: constraintList,
        results,
        latency_ms_total: Number(totalLatencyMs.toFixed(1)),
        notes: routeImpl ? { injected_route: true } : null,
    };
}

module.exports = {
    runAnswerAudit,
    normalizeConstraints,
    normalizeQuestion,
    normalizeLanguage,
    DEFAULT_MODES,
    SUPPORTED_CONSTRAINTS,
};