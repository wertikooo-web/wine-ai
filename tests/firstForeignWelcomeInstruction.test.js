'use strict';

const assert = require('assert');
const {
    FIRST_FOREIGN_WELCOME_INSTRUCTION,
    appendFirstForeignWelcomeInstruction,
} = require('../src/persona/firstForeignWelcomeInstruction');

async function run() {
    let assertionCount = 0;

    assert(FIRST_FOREIGN_WELCOME_INSTRUCTION.includes('Welcome to Moldova!')); assertionCount += 1;
    assert(FIRST_FOREIGN_WELCOME_INSTRUCTION.includes('НЕ на русском и НЕ на румынском')); assertionCount += 1;
    assert(FIRST_FOREIGN_WELCOME_INSTRUCTION.includes('только один раз за сессию')); assertionCount += 1;
    assert(FIRST_FOREIGN_WELCOME_INSTRUCTION.includes('Willkommen in Moldau!')); assertionCount += 1;
    assert(FIRST_FOREIGN_WELCOME_INSTRUCTION.includes('Bienvenue en Moldavie !')); assertionCount += 1;
    assert(FIRST_FOREIGN_WELCOME_INSTRUCTION.includes('モルドバへようこそ')); assertionCount += 1;

    const combined = appendFirstForeignWelcomeInstruction('BASE');
    assert(combined.startsWith('BASE')); assertionCount += 1;
    assert(combined.includes('ПЕРВОЕ ПРИВЕТСТВИЕ ИНОСТРАННОГО ГОСТЯ')); assertionCount += 1;

    return { assertionCount };
}

module.exports = { run };
