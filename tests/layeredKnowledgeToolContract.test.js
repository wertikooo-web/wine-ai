'use strict';

const assert = require('assert');
const tool = require('../src/tools/searchLayeredKnowledge');
const { LEVELS, naturalAnswerPolicy } = require('../src/knowledge/layeredRouter');
const { TOOL_DECLARATIONS, createToolHandlers } = require('../src/tools');

async function run() {
    assert.strictEqual(tool.declaration.name, 'search_wine_knowledge');
    assert.strictEqual(TOOL_DECLARATIONS.filter((item) => item.name === 'search_wine_knowledge').length, 1);

    const context = { searchBlock: null, log: () => {} };
    const handlers = createToolHandlers(context);
    assert.strictEqual(typeof handlers.search_wine_knowledge, 'function');

    const evidence = [{
        level: LEVELS.CANONICAL,
        text: 'grape: Fetească Neagră',
        title: 'feteasca-neagra',
        source: 'entity_facts',
        confidence: 'verified',
        provenance: { entity_id: 'feteasca-neagra' },
    }];
    const deterministicImpl = tool.createImpl(async () => ({
        found: true,
        evidence,
        attempts: [{ level: LEVELS.CANONICAL, status: 'found', count: 1 }],
        used_levels: [LEVELS.CANONICAL],
        web_used: false,
        web_attempted: false,
        freshness_sensitive: false,
        conflicts: [],
        answer_policy: naturalAnswerPolicy(),
    }));

    const result = await deterministicImpl(
        { query: 'Fetească Neagră', language: 'ro' },
        context,
    );

    assert.strictEqual(result.found, true);
    assert.strictEqual(result.status, 'found');
    assert.ok(Array.isArray(result.results));
    assert.ok(Array.isArray(result.evidence));
    assert.deepStrictEqual(result.results, result.evidence);
    assert.deepStrictEqual(result.evidence, evidence);
    assert.deepStrictEqual(result.used_levels, [LEVELS.CANONICAL]);
    assert.strictEqual(result.answer_policy.disclose_internal_search_process, false);
    assert.ok(!JSON.stringify(result.answer_policy).includes('по нашей базе сведений нет'));
    assert.strictEqual(context.searchBlock, 'found');

    console.log('layeredKnowledgeToolContract: all assertions passed');
}

if (require.main === module) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
