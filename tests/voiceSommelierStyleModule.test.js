'use strict';

const assert = require('assert');
const {
    MODULE_ID,
    MODULE_VERSION,
    MOLDOVAN_VARIETIES,
    MOLDOVAN_REGIONS,
    ALLOWED_PROBABILISTIC_MARKERS,
    REFERENCE_EXAMPLES,
    SHORT_ANSWER_EXAMPLES,
    buildVoiceSommelierStyleBlock,
    buildRagPriorityGuidance,
    containsAllowedProbabilisticMarker,
} = require('../src/persona/voiceSommelierStyleModule');

async function run() {
    console.log('Running Voice Sommelier Style Module tests...');

    // --- Canonical marker set is exactly these three, nothing else --------
    console.log('Testing: the allowed probabilistic markers are exactly the three approved phrases...');
    assert.deepStrictEqual(
        [...ALLOWED_PROBABILISTIC_MARKERS],
        ['можно уловить', 'стоит поискать', 'по характеру сорта'],
        'the canonical marker set must be exactly these three phrases, in this form',
    );

    // --- Content requirements -----------------------------------------
    console.log('Testing: module content covers every required rule...');
    const { text, meta } = buildVoiceSommelierStyleBlock();
    assert.strictEqual(meta.id, MODULE_ID);
    assert.strictEqual(meta.version, MODULE_VERSION);
    assert.ok(text.includes('ОДНИМ словом'), 'must instruct a one-word answer for a simple precise question');
    assert.ok(text.includes('2-4 короткими фразами'), 'must instruct 2-4 short phrases for a normal answer');
    assert.ok(/тихой проверки базы|тихая проверка базы/.test(text), 'the short-answer rule must still require the mandatory silent RAG lookup first, not bypass it');
    SHORT_ANSWER_EXAMPLES.forEach((example) => assert.ok(text.includes(example), 'each short-answer example must appear verbatim'));
    MOLDOVAN_VARIETIES.forEach((name) => assert.ok(text.includes(name), `must list variety ${name}`));
    MOLDOVAN_REGIONS.forEach((name) => assert.ok(text.includes(name), `must list region ${name}`));
    ALLOWED_PROBABILISTIC_MARKERS.forEach((marker) => assert.ok(text.includes(marker), `must list allowed marker "${marker}"`));
    assert.strictEqual(REFERENCE_EXAMPLES.length, 6, 'must define exactly six reference examples');
    REFERENCE_EXAMPLES.forEach((example) => assert.ok(text.includes(example), 'each reference example must appear verbatim in the assembled block'));
    // The seven named grapes/regions from the brief must all appear somewhere
    // across the six examples (Fetească Regală + Codru share one example).
    ['Fetească Neagră', 'Rară Neagră', 'Viorica', 'Fetească Regală', 'Codru', 'Ștefan Vodă', 'Valul lui Traian'].forEach((name) => {
        assert.ok(REFERENCE_EXAMPLES.some((example) => example.includes(name)), `some reference example must mention ${name}`);
    });

    // --- RAG priority guidance -------------------------------------------
    console.log('Testing: buildRagPriorityGuidance() prioritizes bottle-specific facts, else hedges...');
    const withCard = buildRagPriorityGuidance({ hasBottleCard: true });
    assert.ok(/уверенно/.test(withCard), 'with a real bottle card, guidance must call for confident, unhedged fact use');
    assert.ok(!containsAllowedProbabilisticMarker(withCard), 'with a real bottle card, guidance itself should not need a probabilistic marker');

    const withoutCard = buildRagPriorityGuidance({ hasBottleCard: false });
    assert.ok(containsAllowedProbabilisticMarker(withoutCard), 'without a bottle card, guidance must reference an allowed probabilistic marker');
    assert.ok(/не выдавай.*за данные производителя/i.test(withoutCard), 'without a bottle card, guidance must explicitly forbid presenting the note as producer data');

    // --- Marker helper -----------------------------------------------------
    console.log('Testing: containsAllowedProbabilisticMarker() only matches the approved vocabulary...');
    assert.strictEqual(containsAllowedProbabilisticMarker('По характеру сорта можно уловить фиалку.'), true);
    assert.strictEqual(containsAllowedProbabilisticMarker('Это точно так пахнет, гарантированно.'), false);

    console.log('ALL VOICE SOMMELIER STYLE MODULE TESTS PASSED!');
    if (require.main === module) {
        process.exit(0);
    }
}

module.exports = { run };

if (require.main === module) {
    run().catch((error) => {
        console.error('Voice Sommelier Style Module tests failed:', error);
        process.exit(1);
    });
}
