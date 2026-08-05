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
    // A stubbed routeImpl that doesn't supply answerable/answerabilityReason
    // must not crash evaluate() -- they default to a safe false/null shape.
    assert.strictEqual(result.answerable, false, 'answerable must default to false, never crash, when the retrieval stub omits it');
    assert.strictEqual(result.answerability_reason, null);

    const unavailable = createTextKnowledgeEvaluator({
        apiKey: '', routeImpl: async () => ({ found: false, evidence: [], used_levels: [], web_used: false }),
    });
    await assert.rejects(() => unavailable.evaluate({ question: 'Есть ли цена?' }), /text_evaluation_unavailable/);

    // found:true but answerable:false (retrieved fragments that don't cover
    // the question) must pass through to the API-shaped result untouched.
    const notAnswerable = createTextKnowledgeEvaluator({
        apiKey: '',
        routeImpl: async () => ({
            found: true, answerable: false, answerabilityReason: 'fragments are generic',
            evidence: [{ level: 'documents', title: 'X', text: 'generic text' }],
            used_levels: ['documents'], web_used: false,
        }),
        generateContent: async () => ({ text: 'Этот факт сейчас не удаётся надёжно подтвердить.' }),
    });
    const notAnswerableResult = await notAnswerable.evaluate({ question: 'Какое вино к баранине?' });
    assert.strictEqual(notAnswerableResult.found, true, 'found must stay true -- evidence was retrieved');
    assert.strictEqual(notAnswerableResult.answerable, false, 'answerable must be reported false separately from found');
    assert.strictEqual(notAnswerableResult.answerability_reason, 'fragments are generic');

    // Fail-open answerability (grader unavailable/unparseable) must be
    // logged server-side -- an outage in the grader must never be silently
    // invisible while every eval run stops actually verifying anything.
    {
        const warnCalls = [];
        const origWarn = console.warn;
        console.warn = (...args) => warnCalls.push(args);
        try {
            // The gate itself now reports answerable:null (unknown) for a
            // fail-open outcome, not true -- evaluate()'s public boolean
            // field collapses that to false (never a false "confirmed"),
            // while the reason field still names exactly what happened.
            const failOpen = createTextKnowledgeEvaluator({
                apiKey: '',
                routeImpl: async () => ({
                    found: true, answerable: null, answerabilityReason: 'answerability_check_unavailable',
                    evidence: [{ level: 'documents', title: 'X', text: 'y' }],
                    used_levels: ['documents'], web_used: false,
                }),
                generateContent: async () => ({ text: 'Some answer.' }),
            });
            const failOpenResult = await failOpen.evaluate({ question: 'Вопрос?' });
            assert.strictEqual(failOpenResult.answerable, false, 'a fail-open (unknown) outcome must never be reported as answerable:true');
            assert.strictEqual(failOpenResult.answerability_reason, 'answerability_check_unavailable', 'the reason must explicitly say the check did not actually run');
            assert.strictEqual(warnCalls.length, 1, 'a fail-open answerability outcome must be logged server-side, not silently pass through');
            assert.ok(warnCalls[0][0].includes('answerability check did not run'), 'the log message must explicitly name the fail-open condition');
        } finally {
            console.warn = origWarn;
        }
    }

    console.log('textKnowledgeEvaluation passed (21 assertions)');
    return { assertionCount: 21 };
}

module.exports = { run };
