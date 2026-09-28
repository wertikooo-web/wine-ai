'use strict';

const assert = require('assert');
const { CORE_PERSONA_PROMPT } = require('../src/persona/wineExpertPersona');

async function run() {
    let assertionCount = 0;

    assert(CORE_PERSONA_PROMPT.includes('ПЕРВОЕ ПРИВЕТСТВИЕ ИНОСТРАННОГО ГОСТЯ')); assertionCount += 1;
    assert(CORE_PERSONA_PROMPT.includes('Welcome to Moldova!')); assertionCount += 1;
    assert(CORE_PERSONA_PROMPT.includes('НЕ на русском и НЕ на румынском')); assertionCount += 1;
    assert(CORE_PERSONA_PROMPT.includes('только один раз за сессию')); assertionCount += 1;
    assert(CORE_PERSONA_PROMPT.includes('слишком короткая или неоднозначная')); assertionCount += 1;
    assert(CORE_PERSONA_PROMPT.includes('Willkommen in Moldau!')); assertionCount += 1;
    assert(CORE_PERSONA_PROMPT.includes('Bienvenue en Moldavie !')); assertionCount += 1;
    assert(CORE_PERSONA_PROMPT.includes('モルドバへようこそ')); assertionCount += 1;

    return { assertionCount };
}

module.exports = { run };
