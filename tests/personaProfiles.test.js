'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const t = require('./helpers/assertions');

// Import store, registry, and prompt functions
const personaStore = require('../src/persona/personaStore');
const { resolveProfile, listProfiles, getProfileById } = require('../src/persona/profileRegistry');
const { getEffectivePersonaPrompt, CORE_PERSONA_PROMPT } = require('../src/persona/wineExpertPersona');

const FILE_PATH = path.resolve(__dirname, '..', 'data', 'persona-overrides.json');
const PORT = 9876;
const BASE = `http://localhost:${PORT}`;

async function waitServer() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${BASE}/health`);
            if (res.ok) return;
        } catch {}
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('Server failed to start');
}

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
        // ==========================================
        // PART 1: IN-PROCESS UNIT TESTS
        // ==========================================

        // Test 1: Registry retrieval
        const profiles = listProfiles();
        t.equal(profiles.length, 2, 'registry must list exactly 2 profiles');
        t.equal(profiles[0].id, 'classic', 'first profile must be classic');
        t.equal(profiles[1].id, 'warm_guide', 'second profile must be warm_guide');
        assertionCount += 3;

        const classicPreset = getProfileById('classic');
        t.equal(classicPreset.personaName, 'Александр', 'classic preset name must be Alexander');
        assertionCount += 1;

        // Test 2: Clean boot default settings
        if (fs.existsSync(FILE_PATH)) fs.unlinkSync(FILE_PATH);
        await personaStore.load();
        
        let state = personaStore.getCached();
        t.equal(state.baseProfileId, 'classic', 'clean boot must default baseProfileId to classic');
        t.equal(state.mood, 'calm', 'clean boot must default mood to calm');
        t.deepEqual(state.overrides, {}, 'clean boot overrides must be empty');
        assertionCount += 3;

        // Test 3: Legacy migration
        if (fs.existsSync(FILE_PATH)) fs.unlinkSync(FILE_PATH);
        fs.writeFileSync(FILE_PATH, JSON.stringify({
            overrides: {
                name: 'Legacy Custom'
            }
        }), 'utf8');
        await personaStore.load();
        
        state = personaStore.getCached();
        t.equal(state.baseProfileId, null, 'legacy config must load with baseProfileId as null');
        t.equal(state.overrides.name, 'Legacy Custom', 'legacy overrides must be preserved');
        assertionCount += 2;

        // Test 4: Switching presets
        await personaStore.save({ baseProfileId: 'warm_guide' });
        state = personaStore.getCached();
        t.equal(state.baseProfileId, 'warm_guide', 'baseProfileId must switch to warm_guide');
        t.deepEqual(state.overrides, {}, 'switching preset must purge all overrides');
        assertionCount += 2;

        // Test 5: Customization mode computation
        const computeMode = (s) => {
            if (s.baseProfileId === null) return 'custom';
            const hasMeaningful = Object.keys(s.overrides).some(key => {
                if (key === 'style') return Object.keys(s.overrides.style || {}).length > 0;
                return s.overrides[key] !== undefined && s.overrides[key] !== null;
            });
            return hasMeaningful ? 'custom' : 'preset';
        };

        t.equal(computeMode(state), 'preset', 'preset profile with empty overrides must resolve to preset mode');
        assertionCount += 1;

        // Apply a style override
        await personaStore.save({
            overrides: {
                style: {
                    responseLength: 'short'
                }
            }
        });
        state = personaStore.getCached();
        t.equal(state.overrides.style.responseLength, 'short', 'style override must be saved');
        t.equal(computeMode(state), 'custom', 'profile with style overrides must resolve to custom mode');
        assertionCount += 2;

        // Test 6: Deep merge style allowlist and reject unknown
        try {
            await personaStore.save({
                overrides: {
                    style: {
                        unknownKey: 'blah'
                    }
                }
            });
            t.fail('must reject unknown style keys');
        } catch (err) {
            t.ok(err.message.includes('Unknown style field'), 'rejects unknown style fields');
            assertionCount += 1;
        }

        // Test 7: Null revert semantics
        await personaStore.save({
            overrides: {
                style: {
                    responseLength: null
                }
            }
        });
        state = personaStore.getCached();
        t.equal(state.overrides.style, undefined, 'setting style override key to null must delete it');
        t.equal(computeMode(state), 'preset', 'after reverting overrides, mode should be preset again');
        assertionCount += 2;

        // Test 8: Reset preset
        await personaStore.save({
            overrides: {
                name: 'Custom Maria'
            }
        });
        t.equal(computeMode(personaStore.getCached()), 'custom', 'mode must become custom');
        assertionCount += 1;

        await personaStore.save({ reset: true });
        state = personaStore.getCached();
        t.equal(state.baseProfileId, 'warm_guide', 'reset must preserve active baseProfileId');
        t.deepEqual(state.overrides, {}, 'reset must clear overrides');
        t.equal(computeMode(state), 'preset', 'reset must return mode to preset');
        assertionCount += 3;

        // Try resetting custom profile (baseProfileId = null)
        await personaStore.save({ baseProfileId: null, overrides: { name: 'My Custom' } });
        try {
            await personaStore.save({ reset: true });
            t.fail('must reject reset when baseProfileId is null');
        } catch (err) {
            t.ok(err.message.includes('Cannot reset a custom profile'), 'rejects reset when baseProfileId is null');
            assertionCount += 1;
        }

        // Test 9: Effective prompt preview composition
        await personaStore.save({ baseProfileId: 'classic', mood: 'warm' });
        const effectivePrompt = getEffectivePersonaPrompt();
        t.ok(effectivePrompt.includes('<!-- PROFILE_PERSONALITY_START -->'), 'must contain personality start tag');
        t.ok(effectivePrompt.includes('Ты говоришь спокойным, размеренным'), 'must contain classic personality text');
        t.ok(effectivePrompt.includes('<!-- STYLE_SETTINGS_START -->'), 'must contain style settings start tag');
        t.ok(effectivePrompt.includes('<!-- MOOD_START -->'), 'must contain mood start tag');
        t.ok(effectivePrompt.includes('Ты общаешься тепло, душевно и дружелюбно'), 'must contain warm mood text');
        t.ok(effectivePrompt.includes('[IMPORTANT SYSTEM RULE]'), 'must contain core enforcement reminder');
        assertionCount += 6;

        // ==========================================
        // PART 2: HTTP API INTEGRATION TESTS
        // ==========================================
        
        // Clean out data file for integration tests boot
        if (fs.existsSync(FILE_PATH)) fs.unlinkSync(FILE_PATH);

        const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
            env: { ...process.env, PORT: String(PORT), DATABASE_URL: '', REALTIME_PROVIDER: 'mock' },
            stdio: 'ignore',
        });

        try {
            await waitServer();

            // 1. GET /api/persona/profiles -> 200
            const profilesRes = await fetch(`${BASE}/api/persona/profiles`);
            t.equal(profilesRes.status, 200, 'GET /api/persona/profiles status must be 200');
            const profilesData = await profilesRes.json();
            t.ok(profilesData.ok, 'GET /api/persona/profiles ok');
            t.equal(profilesData.profiles.length, 2, 'GET /api/persona/profiles lists 2 profiles');
            assertionCount += 3;

            // 2. POST valid baseProfileId
            const postPresetRes = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ baseProfileId: 'warm_guide' }),
            });
            t.equal(postPresetRes.status, 200, 'POST baseProfileId warm_guide status must be 200');
            const postPresetData = await postPresetRes.json();
            t.equal(postPresetData.baseProfileId, 'warm_guide', 'baseProfileId is warm_guide');
            t.equal(postPresetData.customizationMode, 'preset', 'customizationMode is preset after switching');
            t.deepEqual(postPresetData.overrides, {}, 'overrides are empty after preset switch');
            assertionCount += 4;

            // 3. POST valid mood
            const postMoodRes = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mood: 'expert' }),
            });
            t.equal(postMoodRes.status, 200, 'POST mood expert status must be 200');
            const postMoodData = await postMoodRes.json();
            t.equal(postMoodData.mood, 'expert', 'mood updated to expert');
            t.equal(postMoodData.customizationMode, 'preset', 'mood updates do not trigger custom mode');
            assertionCount += 3;

            // 4. invalid baseProfileId -> 400
            const postBadPresetRes = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ baseProfileId: 'invalid_id' }),
            });
            t.equal(postBadPresetRes.status, 400, 'POST invalid baseProfileId status must be 400');
            assertionCount += 1;

            // 5. invalid mood -> 400
            const postBadMoodRes = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mood: 'invalid_mood' }),
            });
            t.equal(postBadMoodRes.status, 400, 'POST invalid mood status must be 400');
            assertionCount += 1;

            // 6. unknown override field -> 400
            const postBadOverrideRes = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ overrides: { unknownField: 'val' } }),
            });
            t.equal(postBadOverrideRes.status, 400, 'POST unknown override field status must be 400');
            assertionCount += 1;

            // 7. customizationMode from client is ignored or rejected
            // Inside overrides -> rejected (400)
            const postModeOverrideRes = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ overrides: { customizationMode: 'custom' } }),
            });
            t.equal(postModeOverrideRes.status, 400, 'POST overrides containing customizationMode must be 400');
            
            // At root level -> ignored (200)
            const postModeRootRes = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ customizationMode: 'custom', overrides: { name: 'Ignored Root Test' } }),
            });
            t.equal(postModeRootRes.status, 200, 'POST root customizationMode is ignored and status is 200');
            const postModeRootData = await postModeRootRes.json();
            t.equal(postModeRootData.customizationMode, 'custom', 'customizationMode is custom because of name override, not root input');
            assertionCount += 3;

            // 8. effectivePromptPreview cannot be saved via POST
            const postPreviewOverrideRes = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ overrides: { effectivePromptPreview: 'hack' } }),
            });
            t.equal(postPreviewOverrideRes.status, 400, 'POST overrides containing effectivePromptPreview must be 400');
            assertionCount += 1;

            // 9. switching preset clears overrides but preserves mood
            // We set mood to 'lively'
            await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mood: 'lively', overrides: { name: 'Maria Override' } }),
            });
            // Switch to classic preset
            const switchRes = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ baseProfileId: 'classic' }),
            });
            const switchData = await switchRes.json();
            t.equal(switchData.mood, 'lively', 'preset switch preserves active mood');
            t.deepEqual(switchData.overrides, {}, 'preset switch clears overrides');
            assertionCount += 2;

            // 10. reset when baseProfileId is null -> 400
            // Set baseProfileId to null
            await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ baseProfileId: null }),
            });
            const badResetRes = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reset: true }),
            });
            t.equal(badResetRes.status, 400, 'POST reset on null baseProfileId must be 400');
            const badResetData = await badResetRes.json();
            t.ok(badResetData.error.includes('Cannot reset a custom profile'), 'reset on null baseProfileId returns error message');
            assertionCount += 2;

            // 11. raw system_prompt does not get compiled blocks
            const getRes = await fetch(`${BASE}/api/persona`);
            const getData = await getRes.json();
            t.equal(getData.system_prompt, CORE_PERSONA_PROMPT, 'system_prompt field is raw default core prompt');
            t.ok(!getData.system_prompt.includes('<!-- PROFILE_PERSONALITY_START -->'), 'raw system_prompt does not get compiled blocks');
            t.ok(getData.effectivePromptPreview.includes('<!-- PROFILE_PERSONALITY_START -->'), 'effectivePromptPreview contains tags');
            assertionCount += 3;

        } finally {
            child.kill();
        }

        console.log(`[PASS] tests/personaProfiles.test.js: ${assertionCount} assertions passed.`);
    } finally {
        // Restore environment and files
        process.env.DATABASE_URL = origDbUrl;
        if (fs.existsSync(FILE_PATH)) fs.unlinkSync(FILE_PATH);
        if (backupExists && backupContent !== null) {
            fs.writeFileSync(FILE_PATH, backupContent, 'utf8');
        }
    }
}

module.exports = { run };

if (require.main === module) {
    run().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
