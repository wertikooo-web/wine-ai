'use strict';

const { bindTool } = require('../src/tools/toolHelpers');
const { TOOL_DECLARATIONS, createToolHandlers } = require('../src/tools');
const { createSessionMemory } = require('../src/memory/sessionMemory');
const t = require('./helpers/assertions');

async function run() {
    t.equal(TOOL_DECLARATIONS.length, 11, 'expected all registered tool declarations including bidirectional pairing tools');
    for (const decl of TOOL_DECLARATIONS) {
        t.ok(decl.name && decl.description && decl.parameters, `tool ${decl.name || '(unnamed)'} must have name/description/parameters`);
    }

    const sessionMemory = createSessionMemory();
    const calls = [];
    const handlers = createToolHandlers({ sessionMemory, isAdultVerified: true, log: (stage, extra) => calls.push({ stage, extra }) });

    // search_wine_knowledge: valid input
    const found = await handlers.search_wine_knowledge({ args: { query: 'Фетяска Нягрэ' }, generationId: 'g1', turnId: 't1' });
    t.ok(found.found === true, 'search_wine_knowledge should find the Fetească Neagră profile');

    // search_wine_knowledge: invalid input (missing required field) must return
    // a structured, safe error — never throw out to the caller.
    const invalid = await handlers.search_wine_knowledge({ args: {}, generationId: 'g1', turnId: 't1' });
    t.equal(invalid.error, 'invalid_input');
    t.equal(invalid.field, 'query');

    // recommend_wine_pairing must also update session memory as a side effect.
    const pairing = await handlers.recommend_wine_pairing({ args: { dish: 'roast lamb', occasion: 'anniversary' }, generationId: 'g1', turnId: 't1' });
    t.ok(pairing.found && pairing.candidates.length === 3, 'dish pairing should return three ranked Moldovan wine styles');
    t.equal(pairing.candidates[0].style_id, 'feteasca-neagra', 'lamb should rank Fetească Neagră first');
    const memoryText = sessionMemory.formatForPrompt();
    t.ok(memoryText && /roast lamb/.test(memoryText), 'recommend_wine_pairing should record the dish into session memory');
    t.ok(/anniversary/.test(memoryText), 'recommend_wine_pairing should record the occasion into session memory');

    const serving = await handlers.recommend_wine_serving({ args: { wine: 'Fetească Neagră' }, generationId: 'g1', turnId: 't1' });
    t.ok(serving.found, 'wine-to-food tool should resolve a known Moldovan grape style');
    t.ok(serving.dishes.length > 0, 'wine-to-food tool should return food matches');

    const unverifiedHandlers = createToolHandlers({ sessionMemory, log: () => {} });
    const blocked = await unverifiedHandlers.recommend_wine_pairing({ args: { dish: 'fish' }, generationId: 'g1', turnId: 't1' });
    t.equal(blocked.error, 'age_verification_required', 'pairing must stay blocked until the host verifies adulthood');

    // update_session_memory: explicit structured recording.
    const updated = await handlers.update_session_memory({ args: { discussedWine: 'Cabernet Sauvignon', budget: 'premium' }, generationId: 'g1', turnId: 't1' });
    t.ok(updated.recorded, 'update_session_memory should report recorded=true when given fields');
    t.deepEqual(updated.fields.sort(), ['budget', 'discussedWine']);

    // compare_grape_varieties: both sides resolved independently.
    const comparison = await handlers.compare_grape_varieties({ args: { grapeA: 'Fetească Neagră', grapeB: 'Cabernet Sauvignon' }, generationId: 'g1', turnId: 't1' });
    t.ok(comparison.grape_a.found && comparison.grape_b.found, 'compare_grape_varieties should find both grapes');

    // get_wine_route_information with no region at all must not throw.
    const route = await handlers.get_wine_route_information({ args: {}, generationId: 'g1', turnId: 't1' });
    t.ok(typeof route.found === 'boolean');

    // Timing/logging: every call above must have logged a tool_executed or
    // tool_error stage (Stage 10's "логировать время выполнения" requirement).
    t.ok(calls.every((c) => c.stage === 'tool_executed' || c.stage === 'tool_error'));
    t.ok(calls.some((c) => typeof c.extra.durationMs === 'number'));

    // Error boundary: an unexpected (non-validation) throw inside impl must
    // collapse to a generic, safe error — never leak the raw message.
    const throwingHandler = bindTool({
        name: 'throwing_tool',
        impl: async () => { throw new Error('leaked internal detail: db password xyz'); },
    }, { log: () => {} });
    const result = await throwingHandler({ args: {}, generationId: 'g1', turnId: 't1' });
    t.equal(result.error, 'tool_execution_failed');
    t.ok(JSON.stringify(result).indexOf('db password') === -1, 'internal error message must never leak to the caller');
}

module.exports = { run };
