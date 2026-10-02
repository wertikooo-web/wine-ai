'use strict';

// Two characters, never hard-wired: Maria (warm_guide, default, feminine) and
// Alexander (classic, masculine). The assembled realtime prompt keeps the
// gender of the persona it was given, whatever profile is active in the
// dashboard; the shared core text carries no gendered verb forms.

const assert = require('assert');
const personaStore = require('../src/persona/personaStore');
const { getEffectivePersonaPrompt, CORE_PERSONA_PROMPT } = require('../src/persona/wineExpertPersona');
const { buildRealtimeSystemInstruction } = require('../src/realtime/realtimePrompt');

function build(profileId) {
    return buildRealtimeSystemInstruction({ persona: getEffectivePersonaPrompt({}, profileId), currentContext: {} }).text;
}

async function run() {
    let n = 0;
    const ok = (cond, msg) => { assert.ok(cond, msg); n += 1; };
    ok(personaStore.getActiveProfileId() === 'warm_guide', 'Maria (warm_guide) is the default active persona');

    const maria = build('warm_guide');
    ok(/Ты — Мария\./.test(maria) && !/Ты — Александр/.test(maria), 'Maria prompt names Maria only');
    ok(maria.includes('я рада помочь') && !maria.includes('я рад помочь'), 'Maria speaks in the feminine');

    const alexander = build('classic');
    ok(/Ты — Александр\./.test(alexander) && !/Ты — Мария/.test(alexander), 'Alexander prompt names Alexander only');
    ok(alexander.includes('я рад помочь') && !alexander.includes('я рада помочь'), 'Alexander keeps the masculine even while Maria is the active profile');
    ok((alexander.match(/GENDER_BLOCK_START/g) || []).length === 1, 'exactly one gender block');

    ok(!/\b(прислала|прислал|рада|рад помочь|рассказала|посоветовала)\b/i.test(CORE_PERSONA_PROMPT), 'shared core text has no gendered verb forms');
    return { assertionCount: n };
}

module.exports = { run };

if (require.main === module) {
    run().then((r) => { console.log(`personaGenderPerProfile passed (${r.assertionCount})`); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
