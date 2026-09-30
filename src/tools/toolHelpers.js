'use strict';

// Shared plumbing for every wine tool: timing, and a structured-error
// boundary (an internal error never leaks its message to the model/user —
// see docs/ARCHITECTURE.md's "Tools" section and AGENTS.md).
//
// Each tool module exports a *descriptor* — { name, description, parameters,
// impl(args, toolContext) } — not a bound handler. `impl` may use
// toolContext.sessionMemory to read/write per-session state.
// `bindTool(descriptor, toolContext)` produces the actual function the
// transport core calls: `({args, generationId, turnId, providerInstanceId})
// => result`, matching src/realtime/geminiLiveProvider.js's
// handleToolCall() contract exactly (single positional object, no second
// argument) — toolContext is captured in the closure instead.
//
// Stage 1 safety gate: external tools (search_web, search_place, fetch_page)
// are physically blocked when the same generation's search_wine_knowledge
// returned NOT_FOUND. This prevents the LLM from falling back to external
// search when the entity was not recognised — see the recovery audit in
// AGENTS.md and the entity resolution benchmark.

const { isWebSearchEnabled } = require('../knowledge/webSearchSetting');

const EXTERNAL_TOOLS = new Set(['search_web', 'search_place', 'fetch_page']);
// Internet tools switched off by the Dashboard "knowledge base only" setting.
// search_place (OpenStreetMap addresses) stays available.
const INTERNET_TOOLS = new Set(['search_web', 'fetch_page']);

// Shared helper for Stage 1 safety gate: sets the external-tool block for
// the current generation when knowledge search returned NOT_FOUND.
// Called by search_wine_knowledge.impl — test uses the same function.
function setSearchBlock(toolContext, finalStatus) {
    if (toolContext && finalStatus === 'not_found') {
        toolContext._blockedGeneration = toolContext._currentGenerationId;
    }
}

// Production 30 Sep: search_wine_knowledge already brought web sources for a
// news question, then the model called search_web for the same question
// (+3.4..4.1s of silence; a prompt instruction did not stop it). Within one
// generation, a search_web after a web-backed knowledge result answers at
// once with those same sources instead of a second internet round-trip.
const WEB_ALREADY_SEARCHED_RESULT_INSTRUCTION = 'The internet was already searched for this question: these are the web sources from the search_wine_knowledge result you already have. Do not search again. Answer now from that evidence; if a detail (such as an exact date) is not there, say briefly that you could not confirm it.';

function requireNonEmptyString(value, fieldName) {
    const str = String(value || '').trim();
    if (!str) {
        throw Object.assign(new Error(`${fieldName}_required`), { code: 'invalid_input', field: fieldName });
    }
    return str;
}

function optionalString(value, maxChars = 200) {
    const str = String(value || '').trim();
    return str ? str.slice(0, maxChars) : '';
}

// Total deadline for one tool call (all providers). Below the realtime
// server's tool turn timeout (PTT_TOOL_TURN_TIMEOUT_MS, 20s) so the model
// always gets a result in time to answer. Production 2026-09-29: a knowledge
// search in /lite ran >10s and the user heard the bridge phrase, then
// nothing. On timeout the model is told to answer briefly and honestly.
function toolDeadlineMs() {
    const value = Number(process.env.TOOL_DEADLINE_MS || 12000);
    return Number.isFinite(value) && value > 0 ? value : 12000;
}

const TOOL_TIMEOUT_RESULT = Object.freeze({
    error: 'tool_timeout',
    message: 'The lookup took too long. Answer briefly and honestly with what you reliably know, without inventing facts, and offer to check again or narrow the question. Do not mention the timeout.',
});

function bindTool({ name, impl }, toolContext = {}) {
    const log = toolContext.log || (() => {});
    const webEnabled = toolContext.isWebSearchEnabled || isWebSearchEnabled;
    return async function toolHandler({ args = {}, generationId, turnId } = {}) {
        const startedAt = Date.now();

        // Stage 1 gate: reject calls without a generationId — undefined
        // generationId would otherwise create an anonymous generation that
        // could accidentally match a stale undefined _blockedGeneration.
        if (!generationId) {
            log('tool_rejected', { tool: name, turnId: turnId || 'none', reason: 'missing_generation_id' });
            return { error: 'missing_generation_id', message: 'Tool call requires a generation identifier.' };
        }

        // Stage 1 gate: expose generationId for tools that need it
        toolContext._currentGenerationId = generationId;

        // Stage 1 gate: block external tools when entity search was not_found
        if (EXTERNAL_TOOLS.has(name) && toolContext._blockedGeneration === generationId) {
            log('tool_blocked', {
                tool: name,
                generationId: generationId || 'none',
                turnId: turnId || 'none',
                reason: 'entity_not_found',
            });
            return {
                error: 'external_search_blocked',
                message: 'External search tools are not available for this query. Answer based on available knowledge or say you do not know.',
            };
        }

        if (name === 'search_web' && toolContext._webDoneGeneration === generationId) {
            log('tool_deduped', {
                tool: name,
                generationId: generationId || 'none',
                turnId: turnId || 'none',
                reason: 'web_already_searched',
            });
            return {
                found: true,
                results: (toolContext._webDoneSources || []).slice(0, 5),
                instruction: WEB_ALREADY_SEARCHED_RESULT_INSTRUCTION,
                tookMs: 0,
            };
        }

        if (INTERNET_TOOLS.has(name) && !webEnabled()) {
            log('tool_blocked', {
                tool: name,
                generationId: generationId || 'none',
                turnId: turnId || 'none',
                reason: 'web_search_disabled',
            });
            return {
                error: 'web_search_disabled',
                message: 'Internet search is turned off. Answer only from the knowledge base results; if they do not contain the answer, say honestly that you do not have this information.',
            };
        }

        try {
            const deadlineMs = toolDeadlineMs();
            let deadlineTimer = null;
            const timedOut = Symbol('tool_timeout');
            const result = await Promise.race([
                Promise.resolve().then(() => impl(args || {}, toolContext)),
                new Promise((resolve) => { deadlineTimer = setTimeout(() => resolve(timedOut), deadlineMs); }),
            ]).finally(() => clearTimeout(deadlineTimer));
            if (result === timedOut) {
                log('tool_timeout', {
                    tool: name,
                    generationId: generationId || 'none',
                    turnId: turnId || 'none',
                    durationMs: Date.now() - startedAt,
                    deadlineMs,
                });
                return { ...TOOL_TIMEOUT_RESULT };
            }
            if (name === 'search_wine_knowledge' && result && result.webUsed === true) {
                toolContext._webDoneGeneration = generationId;
                toolContext._webDoneSources = (Array.isArray(result.webSources) ? result.webSources : [])
                    .map((source) => ({ title: source.title, url: source.url }));
            }
            log('tool_executed', {
                tool: name,
                generationId: generationId || 'none',
                turnId: turnId || 'none',
                durationMs: Date.now() - startedAt,
                ok: true,
            });
            return result;
        } catch (error) {
            const isValidationError = error.code === 'invalid_input';
            log('tool_error', {
                tool: name,
                generationId: generationId || 'none',
                turnId: turnId || 'none',
                durationMs: Date.now() - startedAt,
                validation: isValidationError,
                message: error.message,
            });
            // Validation errors are safe, generic, and already say exactly
            // which field is wrong — useful for the model to self-correct.
            // Anything else (a bug, a knowledge-index read failure) is
            // collapsed to one opaque code so no internal detail leaks.
            return isValidationError
                ? { error: 'invalid_input', field: error.field || null, message: error.message }
                : { error: 'tool_execution_failed' };
        }
    };
}

module.exports = {
    TOOL_TIMEOUT_RESULT,
    toolDeadlineMs,
    requireNonEmptyString,
    optionalString,
    bindTool,
    setSearchBlock,
};
