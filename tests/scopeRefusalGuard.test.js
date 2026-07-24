'use strict';

const { CORE_PERSONA_PROMPT } = require('../src/persona/wineExpertPersona');
const t = require('./helpers/assertions');

async function run() {
    let assertions = 0;

    // Assert that prompt instructions have mandatory search blocks
    t.ok(CORE_PERSONA_PROMPT.includes('ОБЯЗАТЕЛЬНЫЙ ПОИСК'), 'system prompt must contain mandatory search section');
    assertions += 1;

    t.ok(CORE_PERSONA_PROMPT.includes('Границы специализации применяются строго ПОСЛЕ'), 'refusal boundaries must apply strictly after search');
    assertions += 1;

    t.ok(CORE_PERSONA_PROMPT.includes('search_wine_knowledge'), 'system prompt must reference the search_wine_knowledge tool');
    assertions += 1;

    t.ok(CORE_PERSONA_PROMPT.includes('Никогда не генерируй отказ'), 'prompt must forbid immediate refusal before search');
    assertions += 1;

    return { assertionCount: assertions };
}

module.exports = { run };
