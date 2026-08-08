'use strict';

const assert = require('assert');
const {
    ANSWER_MODES,
    DEFAULT_ANSWER_MODE,
    MODE_POLICY,
    isAnswerMode,
    normalizeAnswerMode,
    resolveAnswerMode,
    modePolicy,
    filterLevelsByMode,
    listAnswerModes,
} = require('../src/knowledge/answerModes');

async function run() {
    assert.strictEqual(DEFAULT_ANSWER_MODE, ANSWER_MODES.KNOWLEDGE_WEB);
    assert.deepStrictEqual(Object.keys(ANSWER_MODES), ['KNOWLEDGE_ONLY', 'KNOWLEDGE_CATALOG', 'KNOWLEDGE_WEB', 'EXPERT']);

    // Knowledge only: canonical + documents, no catalog, no web, no inference.
    const only = modePolicy(ANSWER_MODES.KNOWLEDGE_ONLY);
    assert.deepStrictEqual([...only.levels], ['canonical', 'documents']);
    assert.strictEqual(only.allowCatalog, false);
    assert.strictEqual(only.allowWeb, false);
    assert.strictEqual(only.allowInference, false);

    // Knowledge catalog: adds Wine.md catalog, still no web.
    const catalogMode = modePolicy(ANSWER_MODES.KNOWLEDGE_CATALOG);
    assert.deepStrictEqual([...catalogMode.levels], ['canonical', 'catalog', 'documents']);
    assert.strictEqual(catalogMode.allowCatalog, true);
    assert.strictEqual(catalogMode.allowWeb, false);
    assert.strictEqual(catalogMode.allowInference, false);

    // Knowledge web: everything except explicit AI inference.
    const webMode = modePolicy(ANSWER_MODES.KNOWLEDGE_WEB);
    assert.deepStrictEqual([...webMode.levels], ['canonical', 'catalog', 'documents', 'web']);
    assert.strictEqual(webMode.allowWeb, true);
    assert.strictEqual(webMode.allowInference, false);

    // Expert: everything plus inference.
    const expert = modePolicy(ANSWER_MODES.EXPERT);
    assert.deepStrictEqual([...expert.levels], ['canonical', 'catalog', 'documents', 'web']);
    assert.strictEqual(expert.allowWeb, true);
    assert.strictEqual(expert.allowInference, true);

    // Validation / defaults.
    assert.strictEqual(isAnswerMode('knowledge_web'), true);
    assert.strictEqual(isAnswerMode('local_only'), false);
    assert.strictEqual(normalizeAnswerMode('expert'), 'expert');
    assert.strictEqual(normalizeAnswerMode('garbage'), null);
    assert.strictEqual(resolveAnswerMode(undefined), DEFAULT_ANSWER_MODE);
    assert.strictEqual(resolveAnswerMode('nope'), DEFAULT_ANSWER_MODE);
    assert.strictEqual(modePolicy(undefined).id, DEFAULT_ANSWER_MODE);

    // filterLevelsByMode: strips disallowed levels, keeps order.
    const evidence = [
        { level: 'canonical', text: 'a' },
        { level: 'catalog', text: 'b' },
        { level: 'documents', text: 'c' },
        { level: 'web', text: 'd' },
    ];
    assert.deepStrictEqual(
        filterLevelsByMode(evidence, ANSWER_MODES.KNOWLEDGE_ONLY).map((e) => e.level),
        ['canonical', 'documents'],
    );
    assert.deepStrictEqual(
        filterLevelsByMode(evidence, ANSWER_MODES.KNOWLEDGE_CATALOG).map((e) => e.level),
        ['canonical', 'catalog', 'documents'],
    );
    assert.deepStrictEqual(
        filterLevelsByMode(evidence, ANSWER_MODES.KNOWLEDGE_WEB).map((e) => e.level),
        ['canonical', 'catalog', 'documents', 'web'],
    );
    assert.deepStrictEqual(filterLevelsByMode([], ANSWER_MODES.EXPERT), []);
    assert.deepStrictEqual(
        filterLevelsByMode([{ level: 'documents' }], 'bogus_mode'),
        [{ level: 'documents' }],
        'unknown modes resolve to default (knowledge_web) before filtering',
    );

    // Listing always returns all four modes with their flags.
    const list = listAnswerModes();
    assert.strictEqual(list.length, 4);
    const byId = new Map(list.map((m) => [m.mode, m]));
    assert.strictEqual(byId.get('knowledge_only').allowWeb, false);
    assert.strictEqual(byId.get('knowledge_catalog').allowWeb, false);
    assert.strictEqual(byId.get('knowledge_web').allowWeb, true);
    assert.strictEqual(byId.get('expert').allowInference, true);

    // Every mode's declared levels are internally consistent with its flags.
    for (const [mode, policy] of Object.entries(MODE_POLICY)) {
        assert.ok(policy.levels.includes('canonical'), `${mode} must always include canonical`);
        if (!policy.allowCatalog) assert.ok(!policy.levels.includes('catalog'), `${mode} must not list catalog when disabled`);
        if (!policy.allowWeb) assert.ok(!policy.levels.includes('web'), `${mode} must not list web when disabled`);
    }

    console.log('answerModes: all assertions passed');
}

if (require.main === module) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };