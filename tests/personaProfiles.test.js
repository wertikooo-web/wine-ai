'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const t = require('./helpers/assertions');

const FILE_PATH = path.resolve(__dirname, '..', 'data', 'persona-overrides-test-tmp.json');
process.env.PERSONA_OVERRIDES_FILE = FILE_PATH;

// Import store, registry, and prompt functions
const personaStore = require('../src/persona/personaStore');
const { resolveProfile, listProfiles, getProfileById } = require('../src/persona/profileRegistry');
const { getEffectivePersonaPrompt, CORE_PERSONA_PROMPT } = require('../src/persona/wineExpertPersona');
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
        // Targeted default and overrides mood checks
        const classicResolved = personaStore.getProfile('classic');
        t.equal(classicResolved.mood, 'calm', 'classic profile default mood must be calm');

        const warmResolved = personaStore.getProfile('warm_guide');
        t.equal(warmResolved.mood, 'warm', 'warm_guide profile default mood must be warm');

        // profile-specific override works independently
        await personaStore.updateProfile('classic', { mood: 'expert' });
        const classicOverridden = personaStore.getProfile('classic');
        t.equal(classicOverridden.mood, 'expert', 'classic profile custom mood override must be expert');

        const warmStillWarm = personaStore.getProfile('warm_guide');
        t.equal(warmStillWarm.mood, 'warm', 'warm_guide profile remains warm after classic mood update');

        // Reset classic overrides to restore clean state
        await personaStore.resetProfile('classic');
        assertionCount += 4;

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
        console.log('--- TEST 9 COMPILATION PREVIEW ---');
        console.log(effectivePrompt);
        console.log('----------------------------------');
        t.ok(effectivePrompt.includes('<!-- PROFILE_PERSONALITY_START -->'), 'must contain personality start tag');
        t.ok(effectivePrompt.includes('Ты говоришь спокойным, размеренным'), 'must contain classic personality text');
        t.ok(effectivePrompt.includes('<!-- STYLE_SETTINGS_START -->'), 'must contain style settings start tag');
        t.ok(effectivePrompt.includes('<!-- MOOD_START -->'), 'must contain mood start tag');
        t.ok(effectivePrompt.includes('Ты общаешься тепло, душевно и дружелюбно'), 'must contain warm mood text');
        t.ok(effectivePrompt.includes('[IMPORTANT SYSTEM RULE]'), 'must contain core enforcement reminder');
        assertionCount += 6;

        // Clean out data file for integration tests boot
        if (fs.existsSync(FILE_PATH)) fs.unlinkSync(FILE_PATH);

        let stdoutData = '';
        let stderrData = '';
        let resolvedPort = null;

        const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
            env: {
                ...process.env,
                PORT: '0',
                DATABASE_URL: '',
                REALTIME_PROVIDER: 'mock',
                PERSONA_OVERRIDES_FILE: FILE_PATH
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stdout.on('data', (chunk) => {
            const str = chunk.toString();
            stdoutData += str;
            const match = /listening port=(\d+)/i.exec(str);
            if (match) {
                resolvedPort = match[1];
            }
        });

        child.stderr.on('data', (chunk) => {
            stderrData += chunk.toString();
        });

        try {
            const deadline = Date.now() + 6000;
            while (Date.now() < deadline && !resolvedPort) {
                await new Promise(r => setTimeout(r, 50));
            }

            if (!resolvedPort) {
                console.error('--- Server failed to start! Stdout: ---');
                console.error(stdoutData);
                console.error('--- Server Stderr: ---');
                console.error(stderrData);
                throw new Error('Server failed to assign dynamic port');
            }

            const BASE = `http://localhost:${resolvedPort}`;

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

            // ==========================================
            // Phase 2A1: Backend Voice Configuration Tests
            // ==========================================

            // 12. GET /api/persona/profiles returns provider capabilities
            const capabilitiesRes = await fetch(`${BASE}/api/persona/profiles`);
            t.equal(capabilitiesRes.status, 200, 'Capabilities status is 200');
            const capData = await capabilitiesRes.json();
            t.ok(capData.providers && Array.isArray(capData.providers), 'Capabilities returned providers list');

            const geminiCap = capData.providers.find(p => p.id === 'gemini');
            t.ok(geminiCap, 'Gemini provider capability exists');
            t.equal(geminiCap.supportsPerSessionModel, false, 'supportsPerSessionModel is false');
            t.equal(geminiCap.supportsPerSessionVoice, true, 'supportsPerSessionVoice is true');
            t.equal(geminiCap.models[0].displayName, geminiCap.models[0].id, 'displayName matches model id');
            t.ok(geminiCap.models[0].voices.length > 0, 'Gemini has a list of voices');

            // Check that no secret env/API keys are exposed in the JSON response
            const responseStr = JSON.stringify(capData);
            t.ok(!responseStr.includes('AIzaSy') && !responseStr.includes(process.env.GEMINI_API_KEY || 'dummy_never_match'), 'No secrets exposed in capabilities response');
            assertionCount += 7;

            // 13. Pure Resolver Priorities and Provenance Sources
            const { resolveProfileRuntime } = require('../src/persona/runtimeResolver');

            // Priority 1: Explicit server override
            const res1 = resolveProfileRuntime({
                providerId: 'gemini',
                profileRuntimeDefaults: { gemini: { voiceId: 'Charon' } },
                runtimeOverrides: { gemini: { voiceId: 'Zephyr' } },
                legacyClientVoiceId: 'Kore',
                allowLegacyVoice: true,
                providerDefaultVoiceId: 'Fenrir'
            });
            t.equal(res1.resolvedVoiceId, 'Zephyr', 'Priority 1: resolves to server override');
            t.equal(res1.source, 'server_override', 'Provenance is server_override');

            // Priority 2: Legacy client override (allowed)
            const res2 = resolveProfileRuntime({
                providerId: 'gemini',
                profileRuntimeDefaults: { gemini: { voiceId: 'Charon' } },
                runtimeOverrides: {},
                legacyClientVoiceId: 'Kore',
                allowLegacyVoice: true,
                providerDefaultVoiceId: 'Fenrir'
            });
            t.equal(res2.resolvedVoiceId, 'Kore', 'Priority 2: resolves to legacy client voice');
            t.equal(res2.source, 'legacy_client', 'Provenance is legacy_client');

            // Priority 2b: Legacy client override ignored if allowLegacyVoice is false
            const res2b = resolveProfileRuntime({
                providerId: 'gemini',
                profileRuntimeDefaults: { gemini: { voiceId: 'Charon' } },
                runtimeOverrides: {},
                legacyClientVoiceId: 'Kore',
                allowLegacyVoice: false,
                providerDefaultVoiceId: 'Fenrir'
            });
            t.equal(res2b.resolvedVoiceId, 'Charon', 'Priority 2b: ignores legacy client voice if disabled');
            t.equal(res2b.source, 'profile_default', 'Provenance falls back to profile_default');

            // Priority 3: Built-in profile default
            const res3 = resolveProfileRuntime({
                providerId: 'gemini',
                profileRuntimeDefaults: { gemini: { voiceId: 'Charon' } },
                runtimeOverrides: {},
                legacyClientVoiceId: null,
                allowLegacyVoice: true,
                providerDefaultVoiceId: 'Fenrir'
            });
            t.equal(res3.resolvedVoiceId, 'Charon', 'Priority 3: resolves to profile default');
            t.equal(res3.source, 'profile_default', 'Provenance is profile_default');

            // Priority 4: Provider default fallback
            const res4 = resolveProfileRuntime({
                providerId: 'gemini',
                profileRuntimeDefaults: {},
                runtimeOverrides: {},
                legacyClientVoiceId: null,
                allowLegacyVoice: true,
                providerDefaultVoiceId: 'Fenrir'
            });
            t.equal(res4.resolvedVoiceId, 'Fenrir', 'Priority 4: resolves to provider default');
            t.equal(res4.source, 'provider_default', 'Provenance is provider_default');
            assertionCount += 10;

            // 14. POST overrides validation: rejects modelId override
            const badModelRes = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    overrides: {
                        runtimeByProvider: {
                            gemini: { modelId: 'gemini-2.0-flash' }
                        }
                    }
                }),
            });
            t.equal(badModelRes.status, 400, 'POST modelId override returns 400');
            const badModelData = await badModelRes.status === 400 ? await badModelRes.json() : {};
            t.equal(badModelData.error, 'unsupported_runtime_field', 'unsupported_runtime_field error code');

            // 15. POST overrides validation: rejects unknown provider key
            const badProvRes = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    overrides: {
                        runtimeByProvider: {
                            openai: { voiceId: 'alloy' }
                        }
                    }
                }),
            });
            t.equal(badProvRes.status, 400, 'POST unknown provider override returns 400');
            const badProvData = await badProvRes.status === 400 ? await badProvRes.json() : {};
            t.equal(badProvData.error, 'unknown_provider', 'unknown_provider error code');

            // 16. POST overrides validation: rejects mock provider override
            const badMockRes = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    overrides: {
                        runtimeByProvider: {
                            mock: { voiceId: 'mock' }
                        }
                    }
                }),
            });
            t.equal(badMockRes.status, 400, 'POST mock provider override returns 400');
            const badMockData = await badMockRes.status === 400 ? await badMockRes.json() : {};
            t.equal(badMockData.error, 'unsupported_provider_capability', 'unsupported_provider_capability error code');

            // 17. POST overrides validation: rejects invalid voice ID
            const badVoiceRes = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    overrides: {
                        runtimeByProvider: {
                            gemini: { voiceId: 'invalid-voice' }
                        }
                    }
                }),
            });
            t.equal(badVoiceRes.status, 400, 'POST invalid voice override returns 400');
            const badVoiceData = await badVoiceRes.status === 400 ? await badVoiceRes.json() : {};
            t.equal(badVoiceData.error, 'invalid_voice_id', 'invalid_voice_id error code');

            // 18. POST root-field validation: rejects unknown root keys
            const badRootRes = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    foo: 'bar',
                    overrides: {}
                }),
            });
            t.equal(badRootRes.status, 400, 'POST unknown root keys returns 400');
            const badRootData = await badRootRes.status === 400 ? await badRootRes.json() : {};
            t.equal(badRootData.error, 'unknown_root_field', 'unknown_root_field error code');
            assertionCount += 12;

            // 19. POST overrides persistence roundtrip
            // Switch preset first so baseProfileId is classic (preset mode)
            await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ baseProfileId: 'classic' }),
            });

            const goodVoiceRes = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    overrides: {
                        runtimeByProvider: {
                            gemini: { voiceId: 'Zephyr' }
                        }
                    }
                }),
            });
            t.equal(goodVoiceRes.status, 200, 'Valid voiceId override POST returns 200');
            const goodVoiceData = await goodVoiceRes.json();
            t.equal(goodVoiceData.customizationMode, 'custom', 'customizationMode becomes custom when voice override is set');
            t.equal(goodVoiceData.overrides.runtimeByProvider.gemini.voiceId, 'Zephyr', 'Voice override is persisted');

            // 19b. POST voiceId:null override deletion assertion
            const deleteVoiceRes = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    overrides: {
                        runtimeByProvider: {
                            gemini: { voiceId: null }
                        }
                    }
                }),
            });
            t.equal(deleteVoiceRes.status, 200, 'POST voiceId:null returns 200');
            const deleteVoiceData = await deleteVoiceRes.json();
            t.equal(deleteVoiceData.customizationMode, 'preset', 'customizationMode returns to preset');
            t.ok(!deleteVoiceData.overrides.runtimeByProvider, 'voiceId override is deleted');

            // Set the override again to test preset switch and reset
            await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    overrides: {
                        runtimeByProvider: {
                            gemini: { voiceId: 'Zephyr' }
                        }
                    }
                }),
            });

            // Switch presets clears overrides
            const presetSwitchRes = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ baseProfileId: 'classic' }),
            });
            const presetSwitchData = await presetSwitchRes.json();
            t.equal(presetSwitchData.customizationMode, 'preset', 'customizationMode is preset after profile switch');
            t.ok(!presetSwitchData.overrides.runtimeByProvider, 'profile switch purges runtime overrides');
            assertionCount += 10;

            // 20. Damaged JSON loading verification
            // Write invalid JSON format directly to FILE_PATH and trigger load
            fs.writeFileSync(FILE_PATH, '{"baseProfileId": "classic", "mood": "calm", "overrides": { "runtimeByProvider": "invalid_string_not_object" }}', 'utf8');
            const loadedCache = await personaStore.load();
            t.ok(loadedCache, 'Load does not crash on damaged overrides config');
            t.ok(typeof loadedCache.overrides === 'object', 'overrides defaults to object');
            t.ok(!loadedCache.overrides.runtimeByProvider || Object.keys(loadedCache.overrides.runtimeByProvider).length === 0, 'corrupted runtimeByProvider falls back to safe empty object');

            // Verify DB string is preserved (not overwritten by the fallback)
            const rawContent = fs.readFileSync(FILE_PATH, 'utf8');
            t.ok(rawContent.includes('invalid_string_not_object'), 'Raw JSON file content remains intact and is not overwritten automatically');
            assertionCount += 4;

        } catch (err) {
            console.error('--- Integration Test Failed! Server Stdout: ---');
            console.error(stdoutData);
            console.error('--- Server Stderr: ---');
            console.error(stderrData);
            throw err;
        } finally {
            child.kill();
            await new Promise((resolveExit) => {
                child.on('exit', () => resolveExit());
            });
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
