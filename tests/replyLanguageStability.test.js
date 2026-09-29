'use strict';

// Language stability in long voice conversations: foreign-language evidence
// (Romanian/English KOS documents and web grounding) must be restated in the
// user's language, numbers included, never read verbatim. Guarded in two
// places: the persona's ЯЗЫК block and every search_wine_knowledge result.

const t = require('./helpers/assertions');
const { CORE_PERSONA_PROMPT } = require('../src/persona/wineExpertPersona');
const { createImpl } = require('../src/tools/searchLayeredKnowledge');

async function run() {
    t.ok(/Язык ответа — язык собеседника, а не язык найденных данных/.test(CORE_PERSONA_PROMPT), 'persona: reply language is the user\'s, not the evidence\'s');
    t.ok(/Числа, даты, годы урожая, цены[^.]*всегда произноси на языке ответа/.test(CORE_PERSONA_PROMPT), 'persona: numbers spoken in the reply language');
    t.ok(/Держи язык и произношение ровными весь разговор/.test(CORE_PERSONA_PROMPT), 'persona: stable language across a long conversation');

    const routed = async () => ({
        found: true,
        evidence: [{ title: 'Chișinău', text: 'Populația municipiului Chișinău este de 779 300 de locuitori.' }],
        used_levels: ['documents', 'web'], web_used: true, answerable: true, conflicts: [],
        answer_policy: { final_instruction: 'Answer from the evidence.' },
    });
    const tool = createImpl(routed);
    for (const companionScreen of [false, true]) {
        const out = await tool({ query: 'население Кишинева' }, { isWebSearchEnabled: () => true, companionScreen });
        const instruction = out && out.answer_policy && out.answer_policy.final_instruction;
        t.ok(typeof instruction === 'string' && instruction.indexOf('Answer in the language the user is speaking') > 0, `companionScreen=${companionScreen}: the tool's own instruction kept, language rule appended after it`);
        t.ok(/Answer in the language the user is speaking, not the language of this evidence/.test(instruction), `companionScreen=${companionScreen}: reply-language instruction appended`);
        t.ok(/numbers, dates, vintages, prices and units in that language/.test(instruction), `companionScreen=${companionScreen}: numbers in the user's language`);
        t.equal(instruction.split('Answer in the language the user is speaking').length, 2, `companionScreen=${companionScreen}: appended exactly once`);
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('replyLanguageStability tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
