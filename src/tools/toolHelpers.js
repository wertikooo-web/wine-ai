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

const EXTERNAL_TOOLS = new Set(['search_web', 'search_place', 'fetch_page']);

// Shared helper for Stage 1 safety gate: sets the external-tool block for
// the current generation when knowledge search returned NOT_FOUND.
// Called by search_wine_knowledge.impl — test uses the same function.
function setSearchBlock(toolContext, finalStatus) {
    if (toolContext && finalStatus === 'not_found') {
        toolContext._blockedGeneration = toolContext._currentGenerationId;
    }
}

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

function bindTool({ name, impl }, toolContext = {}) {
    const log = toolContext.log || (() => {});
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

        try {
            const result = await impl(args || {}, toolContext);
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
    requireNonEmptyString,
    optionalString,
    bindTool,
    setSearchBlock,
};
