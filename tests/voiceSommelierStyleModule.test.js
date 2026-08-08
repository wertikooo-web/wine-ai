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
} = require('../src/persona/voiceSommelierStyleModule');

async function run() {
    console.log('Running Voice Sommelier Style Module tests (content of the assembled prompt block)...');

    const { text, meta } = buildVoiceSommelierStyleBlock();
    assert.strictEqual(meta.id, MODULE_ID);
    assert.strictEqual(meta.version, MODULE_VERSION);

    // --- Short-answer rule, with mandatory silent RAG lookup preserved -----
    console.log('Testing: short-answer format rule is present, and does not bypass the mandatory silent RAG lookup...');
    assert.ok(text.includes('ОДНИМ словом'), 'must instruct a one-word answer for a simple precise question');
    assert.ok(text.includes('2-4 короткими фразами'), 'must instruct 2-4 short phrases for a normal answer');
    assert.ok(/тихой проверки базы|тихая проверка базы/.test(text), 'the short-answer rule must still require the mandatory silent RAG lookup first, not bypass it');
    SHORT_ANSWER_EXAMPLES.forEach((example) => assert.ok(text.includes(example), `short-answer example must appear verbatim: ${example}`));
    ['Сухое', 'Красное', 'Да, подойдёт', 'Лучше слегка охладить'].forEach((shortAnswer) => {
        assert.ok(text.includes(`«${shortAnswer}»`), `the exact short-answer wording "${shortAnswer}" from the brief must appear in the module`);
    });

    // --- No text-document formatting in voice output -----------------------
    console.log('Testing: the module forbids headers/tables/lists/ad copy in voice output...');
    assert.ok(/заголовк/i.test(text) && /таблиц/i.test(text) && /списк/i.test(text), 'must explicitly forbid headers, tables, and lists in the spoken answer');

    // --- RAG priority: bottle facts outrank general variety/region notes ---
    console.log('Testing: RAG/bottle-card priority rule is present...');
    assert.ok(/подтверждённые факты.*этой бутылке|факты.*конкретной бутылке/.test(text), 'must state that confirmed facts about the specific bottle come first');
    assert.ok(/не выдавай.*за данные производителя/i.test(text), 'must forbid presenting a stylistic guess as producer data');

    // --- Moldovan varieties and regions -------------------------------------
    console.log('Testing: Moldovan varieties and regions are all listed, including Fetească Albă...');
    assert.deepStrictEqual([...MOLDOVAN_VARIETIES], ['Fetească Neagră', 'Rară Neagră', 'Viorica', 'Fetească Regală', 'Fetească Albă']);
    assert.deepStrictEqual([...MOLDOVAN_REGIONS], ['Codru', 'Ștefan Vodă', 'Valul lui Traian']);
    MOLDOVAN_VARIETIES.forEach((name) => assert.ok(text.includes(name), `must list variety ${name}`));
    MOLDOVAN_REGIONS.forEach((name) => assert.ok(text.includes(name), `must list region ${name}`));
    assert.ok(/не шаблон|важнее общего описания/.test(text), 'must state that specific bottle data outranks generic variety/region description, not that the list becomes a template');

    // --- Broad, natural marker vocabulary -----------------------------------
    console.log('Testing: the soft-marker vocabulary bank matches the approved broader set...');
    assert.deepStrictEqual(
        [...ALLOWED_PROBABILISTIC_MARKERS],
        ['можно уловить', 'стоит поискать', 'по характеру сорта', 'обычно', 'часто слышны', 'можно ждать', 'может быть', 'в этом стиле часто встречается'],
    );
    ALLOWED_PROBABILISTIC_MARKERS.forEach((marker) => assert.ok(text.includes(marker), `must list marker "${marker}"`));

    // --- Six reference examples, verbatim and thematically complete --------
    console.log('Testing: all six reference examples are present verbatim and Moldovan-only...');
    assert.strictEqual(REFERENCE_EXAMPLES.length, 6, 'must define exactly six reference examples');
    REFERENCE_EXAMPLES.forEach((example) => assert.ok(text.includes(example), 'each reference example must appear verbatim in the assembled block'));

    console.log('Testing: the six examples cover every required theme...');
    assert.ok(/Сухое/.test(REFERENCE_EXAMPLES[0]), 'example 1 must demonstrate a short, clear answer');
    assert.ok(ALLOWED_PROBABILISTIC_MARKERS.some((m) => REFERENCE_EXAMPLES[1].includes(m)), 'example 2 must demonstrate a variety description with a hedged marker, not false precision');
    assert.ok(/подтверждено|точные данные/.test(REFERENCE_EXAMPLES[2]), 'example 3 must demonstrate bottle-specific facts outranking a general variety/region note');
    assert.ok(!/^[А-Я][а-я]+\s—\s(белое|красное|сухое|полусухое)/.test(REFERENCE_EXAMPLES[3]), 'example 4 must read as natural speech, not a catalog-card line ("Name — dry white")');
    assert.ok(/стейк|мяс/i.test(REFERENCE_EXAMPLES[4]) && /взросл/i.test(REFERENCE_EXAMPLES[4]), 'example 5 must be a food pairing answer framed for an adult audience');
    assert.ok(/попробовать|простыми словами/i.test(REFERENCE_EXAMPLES[5]), 'example 6 must be a tasting invitation / simple-words explanation');

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
