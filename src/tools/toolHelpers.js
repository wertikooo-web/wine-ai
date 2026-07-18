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
};
