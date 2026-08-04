'use strict';

const assert = require('assert');
const {
    createTextKnowledgeEvaluator,
    MAX_QUESTION_CHARS,
    normalizeQuestion,
} = require('../src/evaluation/textKnowledgeEvaluation');

async function run() {
    assert.throws(() => normalizeQuestion(''), /question_required/);
    assert.throws(() => normalizeQuestion('x'.repeat(MAX_QUESTION_CHARS + 1)), /question_too_long/);

    const calls = [];
    const evaluator = createTextKnowledgeEvaluator({
        apiKey: '',
        routeImpl: async (question, options) => {
            calls.push({ question, options });
            return {
                found: true,
                evidence: [{
                    level: 'documents', title: 'Aurelius', source: 'https://aurelius.md',
                    source_type: 'official_winery', confidence: 'high',
                    text: 'Aurelius produces Fetească Neagră in Moldova.',
                }],
                used_levels: ['documents'], web_used: false,
            };
        },
        generateContent: async ({ model, prompt }) => ({
            text: 'Aurelius produces Fetească Neagră in Moldova.',
            usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10, totalTokenCount: 40 },
            model, prompt,
        }),
    });

    const result = await evaluator.evaluate({ question: 'Что делает Aurelius?', language: 'ru' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.answer, 'Aurelius produces Fetească Neagră in Moldova.');
    assert.deepStrictEqual(result.used_levels, ['documents']);
    assert.strictEqual(result.web_used, false);
    assert.strictEqual(result.evidence.length, 1);
    assert.strictEqual(result.usage.total_tokens, 40);
    assert.strictEqual(calls[0].options.allowWeb, false, 'web is off by default for repeatable evaluation');

    const unavailable = createTextKnowledgeEvaluator({
        apiKey: '', routeImpl: async () => ({ found: false, evidence: [], used_levels: [], web_used: false }),
    });
    await assert.rejects(() => unavailable.evaluate({ question: 'Есть ли цена?' }), /text_evaluation_unavailable/);

    console.log('textKnowledgeEvaluation passed (12 assertions)');
    return { assertionCount: 12 };
}

module.exports = { run };
