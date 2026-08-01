'use strict';

const assert = require('assert');
const tool = require('../src/tools/searchLayeredKnowledge');
const { TOOL_DECLARATIONS, createToolHandlers } = require('../src/tools');

async function run() {
    assert.strictEqual(tool.declaration.name, 'search_wine_knowledge');
    assert.strictEqual(TOOL_DECLARATIONS.filter((item) => item.name === 'search_wine_knowledge').length, 1);

    const context = { searchBlock: null, log: () => {} };
    const handlers = createToolHandlers(context);
    assert.strictEqual(typeof handlers.search_wine_knowledge, 'function');

    const result = await handlers.search_wine_knowledge({
        args: { query: 'Fetească Neagră', language: 'ro' },
        generationId: 'g-layered-contract',
        turnId: 't-layered-contract',
    });

    assert.strictEqual(result.found, true);
    assert.strictEqual(result.status, 'found');
    assert.ok(Array.isArray(result.results));
    assert.ok(Array.isArray(result.evidence));
    assert.deepStrictEqual(result.results, result.evidence);
    assert.ok(Array.isArray(result.used_levels));
    assert.strictEqual(result.answer_policy.disclose_internal_search_process, false);
    assert.ok(!JSON.stringify(result.answer_policy).includes('по нашей базе сведений нет'));

    console.log('layeredKnowledgeToolContract: all assertions passed');
}

if (require.main === module) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
