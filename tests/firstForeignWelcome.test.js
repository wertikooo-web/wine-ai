'use strict';

const assert = require('assert');
const {
    shouldSendForeignWelcome,
    getForeignWelcomeText,
    buildFirstTurnWelcomeInstruction,
} = require('../src/realtime/firstForeignWelcome');

async function run() {
    let assertionCount = 0;

    assert.strictEqual(shouldSendForeignWelcome({ language: 'en', alreadySent: false }), true); assertionCount += 1;
    assert.strictEqual(shouldSendForeignWelcome({ language: 'de', alreadySent: false }), true); assertionCount += 1;
    assert.strictEqual(shouldSendForeignWelcome({ language: 'fr', alreadySent: false }), true); assertionCount += 1;
    assert.strictEqual(shouldSendForeignWelcome({ language: 'ru', alreadySent: false }), false); assertionCount += 1;
    assert.strictEqual(shouldSendForeignWelcome({ language: 'ro', alreadySent: false }), false); assertionCount += 1;
    assert.strictEqual(shouldSendForeignWelcome({ language: 'en', alreadySent: true }), false); assertionCount += 1;

    assert.strictEqual(getForeignWelcomeText('en'), 'Welcome to Moldova!'); assertionCount += 1;
    assert.strictEqual(getForeignWelcomeText('de'), 'Willkommen in Moldau!'); assertionCount += 1;
    assert.strictEqual(getForeignWelcomeText('fr'), 'Bienvenue en Moldavie !'); assertionCount += 1;
    assert.strictEqual(getForeignWelcomeText('ja'), 'モルドバへようこそ！'); assertionCount += 1;

    const enInstruction = buildFirstTurnWelcomeInstruction({ language: 'en', alreadySent: false });
    assert(enInstruction.includes('Welcome to Moldova!')); assertionCount += 1;
    assert(enInstruction.includes('once only')); assertionCount += 1;
    assert.strictEqual(buildFirstTurnWelcomeInstruction({ language: 'ru', alreadySent: false }), null); assertionCount += 1;
    assert.strictEqual(buildFirstTurnWelcomeInstruction({ language: 'ro', alreadySent: false }), null); assertionCount += 1;
    assert.strictEqual(buildFirstTurnWelcomeInstruction({ language: 'en', alreadySent: true }), null); assertionCount += 1;

    return { assertionCount };
}

module.exports = { run };
