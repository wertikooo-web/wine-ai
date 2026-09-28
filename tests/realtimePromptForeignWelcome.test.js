'use strict';

const assert = require('assert');
const { buildRealtimeSystemInstruction } = require('../src/realtime/realtimePrompt');

async function run() {
    let assertionCount = 0;

    const defaultBuilt = buildRealtimeSystemInstruction({
        persona: 'CUSTOM PERSONA',
        currentContext: { sessionLanguage: 'auto', recentTurns: [] },
    });
    assert(defaultBuilt.text.includes('ПЕРВОЕ ПРИВЕТСТВИЕ ИНОСТРАННОГО ГОСТЯ')); assertionCount += 1;
    assert(defaultBuilt.text.includes('Welcome to Moldova!')); assertionCount += 1;
    assert(defaultBuilt.text.includes('CUSTOM PERSONA')); assertionCount += 1;

    const occurrences = defaultBuilt.text.split('ПЕРВОЕ ПРИВЕТСТВИЕ ИНОСТРАННОГО ГОСТЯ').length - 1;
    assert.strictEqual(occurrences, 1); assertionCount += 1;

    return { assertionCount };
}

module.exports = { run };
