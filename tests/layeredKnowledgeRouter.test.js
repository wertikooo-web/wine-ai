'use strict';

const assert = require('assert');
const {
    isFreshnessQuery,
    isCatalogQuery,
    naturalAnswerPolicy,
} = require('../src/knowledge/layeredRouter');

async function run() {
    assert.strictEqual(isCatalogQuery('Сколько стоит Cricova Brut и есть ли в наличии?'), true);
    assert.strictEqual(isCatalogQuery('Расскажи историю винодельни Cricova'), false);
    assert.strictEqual(isFreshnessQuery('Какое сейчас расписание экскурсий?'), true);
    assert.strictEqual(isFreshnessQuery('Из какого сорта делают это вино?'), false);

    const policy = naturalAnswerPolicy();
    assert.strictEqual(policy.disclose_internal_search_process, false);
    assert.strictEqual(policy.tone, 'confident_clear');
    assert.ok(policy.rules.some((rule) => rule.includes('Do not say that the internal database lacked information')));
    assert.ok(policy.rules.some((rule) => rule.includes('Do not announce that web search was used')));

    console.log('layeredKnowledgeRouter: all assertions passed');
}

if (require.main === module) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
