'use strict';

const assert = require('assert');
const { deriveFirstForeignWelcomeState } = require('../src/realtime/firstForeignWelcomePolicy');

async function run() {
    let assertionCount = 0;

    const en = deriveFirstForeignWelcomeState({ detectedLanguage: 'en' });
    assert.strictEqual(en.firstMeaningfulTurnSeen, true); assertionCount += 1;
    assert.strictEqual(en.alreadySent, true); assertionCount += 1;
    assert.strictEqual(en.welcomePending, true); assertionCount += 1;
    assert(en.instruction.includes('Welcome to Moldova!')); assertionCount += 1;

    const ru = deriveFirstForeignWelcomeState({ detectedLanguage: 'ru' });
    assert.strictEqual(ru.alreadySent, false); assertionCount += 1;
    assert.strictEqual(ru.welcomePending, false); assertionCount += 1;
    assert.strictEqual(ru.instruction, null); assertionCount += 1;

    const laterForeign = deriveFirstForeignWelcomeState({
        detectedLanguage: 'de',
        firstMeaningfulTurnSeen: true,
        alreadySent: false,
    });
    assert.strictEqual(laterForeign.welcomePending, false); assertionCount += 1;
    assert.strictEqual(laterForeign.alreadySent, false); assertionCount += 1;

    return { assertionCount };
}

module.exports = { run };
