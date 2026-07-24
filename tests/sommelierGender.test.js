'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const t = require('./helpers/assertions');

// Import store and prompt functions
const personaStore = require('../src/persona/personaStore');
const {
    getRawPersonaPrompt,
    getEffectivePersonaPrompt,
    appendSommelierGenderInstruction,
    currentPersonaSommelierGender,
    CORE_PERSONA_PROMPT,
} = require('../src/persona/wineExpertPersona');
const {
    buildRealtimeSystemInstruction,
    defaultPromptBlocks,
    sanitizePromptConfig,
} = require('../src/realtime/realtimePrompt');

const FILE_PATH = path.resolve(__dirname, '..', 'data', 'persona-overrides.json');

async function run() {
    let assertionCount = 0;

    // Backup existing overrides file if any
    let backupContent = null;
    const backupExists = fs.existsSync(FILE_PATH);
    if (backupExists) {
        backupContent = fs.readFileSync(FILE_PATH, 'utf8');
    }

    // Force file-backed mode by temporarily disabling database URL
    const origDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = '';

    try {
        // --- Legacy Config -> Default Test ---
        // Clean store state to simulate legacy config without gender field
        if (fs.existsSync(FILE_PATH)) fs.unlinkSync(FILE_PATH);
        fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
        fs.writeFileSync(FILE_PATH, JSON.stringify({ name: 'Old Wine AI' }), 'utf8');
        
        await personaStore.load();
        t.equal(currentPersonaSommelierGender(), 'male', 'legacy config must default sommelierGender to male');
        assertionCount += 1;

        // --- Male Prompt Composition Test ---
        await personaStore.save({ sommelierGender: 'male' });
        let effectiveMale = getEffectivePersonaPrompt();
        t.ok(effectiveMale.includes('ГРАММАТИЧЕСКИЙ РОД ПЕРСОНАЖА:'), 'male effective prompt must contain the ГРАММАТИЧЕСКИЙ РОД ПЕРСОНАЖА block');
        t.ok(effectiveMale.includes('я рад помочь'), 'male prompt must contain male Russian endings');
        t.ok(effectiveMale.includes('sunt bucuros'), 'male prompt must contain male Romanian endings');
        assertionCount += 3;

        // --- Female Prompt Composition Test ---
        await personaStore.save({ sommelierGender: 'female' });
        let effectiveFemale = getEffectivePersonaPrompt();
        t.ok(effectiveFemale.includes('ГРАММАТИЧЕСКИЙ РОД ПЕРСОНАЖА:'), 'female effective prompt must contain the ГРАММАТИЧЕСКИЙ РОД ПЕРСОНАЖА block');
        t.ok(effectiveFemale.includes('я рада помочь'), 'female prompt must contain female Russian endings');
        t.ok(effectiveFemale.includes('sunt bucuroasă'), 'female prompt must contain female Romanian endings');
        assertionCount += 3;

        // --- Gender block added exactly once / Raw prompt remains clean ---
        t.ok(!getRawPersonaPrompt().includes('ГРАММАТИЧЕСКИЙ РОД ПЕРСОНАЖА:'), 'raw prompt must not contain gender instruction');
        assertionCount += 1;

        const occurrenceCount = (effectiveFemale.match(/ГРАММАТИЧЕСКИЙ РОД ПЕРСОНАЖА/g) || []).length;
        t.equal(occurrenceCount, 1, 'gender block must be added exactly once in effective prompt');
        assertionCount += 1;

        // --- Invalid Value -> 400 Validation Test ---
        await assert.rejects(async () => {
            await personaStore.save({ sommelierGender: 'other' });
        }, (err) => err.statusCode === 400 && err.message === 'invalid_sommelier_gender', 'saving invalid gender "other" must reject with 400');
        assertionCount += 1;

        await assert.rejects(async () => {
            await personaStore.save({ sommelierGender: '' });
        }, (err) => err.statusCode === 400 && err.message === 'invalid_sommelier_gender', 'saving empty string gender must reject with 400');
        assertionCount += 1;

        await assert.rejects(async () => {
            await personaStore.save({ sommelierGender: null });
        }, (err) => err.statusCode === 400 && err.message === 'invalid_sommelier_gender', 'saving null gender must reject with 400');
        assertionCount += 1;

        await assert.rejects(async () => {
            await personaStore.save({ sommelierGender: 'Female' }); // Case sensitivity check
        }, (err) => err.statusCode === 400 && err.message === 'invalid_sommelier_gender', 'saving capitalized "Female" must reject with 400');
        assertionCount += 1;

        // --- Undefined value does not change saved value ---
        await personaStore.save({ sommelierGender: 'female' });
        await personaStore.save({ name: 'Updated Name Only', sommelierGender: undefined });
        t.equal(currentPersonaSommelierGender(), 'female', 'saving undefined sommelierGender must keep the existing value');
        assertionCount += 1;

        // --- API Save/Load Round Trip ---
        await personaStore.save({ sommelierGender: 'female' });
        await personaStore.load();
        t.equal(currentPersonaSommelierGender(), 'female', 'saved gender must persist across load calls');
        assertionCount += 1;

        // --- New realtime session gets effective prompt through real assembly path ---
        await personaStore.save({ sommelierGender: 'female' });
        let blocksFemale = defaultPromptBlocks();
        t.ok(blocksFemale.persona.includes('я рада помочь'), 'new session default blocks must get female effective prompt when configured female');
        assertionCount += 1;

        // Real assembly path test
        let assembledFemale = buildRealtimeSystemInstruction({
            persona: blocksFemale.persona,
            currentContext: 'Context'
        });
        t.ok(assembledFemale.text.includes('я рада помочь'), 'assembled system instruction text must include female gender instruction');
        const assembledOccurrences = (assembledFemale.text.match(/ГРАММАТИЧЕСКИЙ РОД ПЕРСОНАЖА/g) || []).length;
        t.equal(assembledOccurrences, 1, 'gender block must be added exactly once in the assembled system instruction');
        assertionCount += 2;

        await personaStore.save({ sommelierGender: 'male' });
        let blocksMale = defaultPromptBlocks();
        t.ok(blocksMale.persona.includes('я рад помочь'), 'new session default blocks must get male effective prompt when configured male');
        assertionCount += 1;

        // --- Custom persona prompt gets selected gender block exactly once ---
        await personaStore.save({ sommelierGender: 'female' });
        
        // Scenario A: Custom prompt WITHOUT existing gender instruction
        const customPromptRaw = 'Custom prompt content without gender rule';
        const assembledCustomFemale = buildRealtimeSystemInstruction({
            persona: customPromptRaw,
            currentContext: 'Context'
        });
        t.ok(assembledCustomFemale.text.includes('я рада помочь'), 'custom prompt must receive female gender instruction');
        const customOccurrences = (assembledCustomFemale.text.match(/ГРАММАТИЧЕСКИЙ РОД ПЕРСОНАЖА/g) || []).length;
        t.equal(customOccurrences, 1, 'custom prompt must receive gender instruction exactly once');
        assertionCount += 2;
        
        // Scenario B: Custom prompt WITH existing gender instruction
        const customPromptWithGender = 'Custom prompt content\n\n<!-- GENDER_BLOCK_START -->\nГРАММАТИЧЕСКИЙ РОД ПЕРСОНАЖА:\nТы говоришь о себе в женском роде...\n<!-- GENDER_BLOCK_END -->';
        const assembledCustomWithGender = buildRealtimeSystemInstruction({
            persona: customPromptWithGender,
            currentContext: 'Context'
        });
        t.ok(assembledCustomWithGender.text.includes('ГРАММАТИЧЕСКИЙ РОД ПЕРСОНАЖА:'), 'custom prompt with existing gender instruction remains intact');
        const customWithGenderOccurrences = (assembledCustomWithGender.text.match(/ГРАММАТИЧЕСКИЙ РОД ПЕРСОНАЖА/g) || []).length;
        t.equal(customWithGenderOccurrences, 1, 'custom prompt with existing gender instruction must not duplicate it');
        assertionCount += 2;

        // --- sanitizePromptConfig regression test ---
        await personaStore.save({ sommelierGender: 'female' });
        const sanitizedCustomFemale = sanitizePromptConfig({
            persona: 'My Custom Persona Prompt'
        }, { allowCustomPrompt: true });
        t.ok(sanitizedCustomFemale.blocks.persona.includes('я рада помочь'), 'sanitized custom prompt must receive female gender instruction');
        const sanitizedOccurrences = (sanitizedCustomFemale.blocks.persona.match(/ГРАММАТИЧЕСКИЙ РОД ПЕРСОНАЖА/g) || []).length;
        t.equal(sanitizedOccurrences, 1, 'sanitized custom prompt must receive gender instruction exactly once');
        assertionCount += 2;

        // --- Gender block switching test ---
        // Start with male
        await personaStore.save({ sommelierGender: 'male' });
        let promptMale = getEffectivePersonaPrompt();
        t.ok(promptMale.includes('я рад помочь'), 'pre-condition: effective prompt is male');
        t.ok(!promptMale.includes('я рада помочь'), 'pre-condition: effective prompt does not contain female');
        assertionCount += 2;

        // Now switch to female
        await personaStore.save({ sommelierGender: 'female' });
        // Re-processing the male effective prompt
        let promptSwitched = appendSommelierGenderInstruction(promptMale);
        t.ok(promptSwitched.includes('я рада помочь'), 'after switching, prompt must contain female instruction');
        t.ok(!promptSwitched.includes('я рад помочь'), 'after switching, prompt must not contain male instruction');
        const switchedOccurrences = (promptSwitched.match(/ГРАММАТИЧЕСКИЙ РОД ПЕРСОНАЖА/g) || []).length;
        t.equal(switchedOccurrences, 1, 'gender block must be present exactly once after switching');
        assertionCount += 3;

        // --- Active session is unaffected ---
        await personaStore.save({ sommelierGender: 'male' });
        let activeSessionPromptBlocks = defaultPromptBlocks(); // initialized as male
        t.ok(activeSessionPromptBlocks.persona.includes('я рад помочь'), 'pre-condition: active session is male');
        assertionCount += 1;

        // Modify settings to female
        await personaStore.save({ sommelierGender: 'female' });

        // Verify active session's local prompt blocks are unaffected
        t.ok(activeSessionPromptBlocks.persona.includes('я рад помочь') && !activeSessionPromptBlocks.persona.includes('я рада помочь'), 'active session prompt blocks must remain unchanged after updating settings');
        assertionCount += 1;

    } finally {
        // Restore database environment variable
        process.env.DATABASE_URL = origDbUrl;

        // Restore overrides file backup
        if (fs.existsSync(FILE_PATH)) fs.unlinkSync(FILE_PATH);
        if (backupExists && backupContent !== null) {
            fs.writeFileSync(FILE_PATH, backupContent, 'utf8');
        }
    }

    return { assertionCount };
}

module.exports = { run };
