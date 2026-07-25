'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const t = require('./helpers/assertions');

const FILE_PATH = path.resolve(__dirname, '..', 'data', 'persona-overrides-test-tmp.json');
process.env.PERSONA_OVERRIDES_FILE = FILE_PATH;

const personaStore = require('../src/persona/personaStore');
const { resolveProfile } = require('../src/persona/profileRegistry');
const { getEffectivePersonaPrompt } = require('../src/persona/wineExpertPersona');
const PORT = 9877;
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

    let backupContent = null;
    const backupExists = fs.existsSync(FILE_PATH);
    if (backupExists) {
        backupContent = fs.readFileSync(FILE_PATH, 'utf8');
    }

    const origDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = ''; // force file fallback

    try {
        if (fs.existsSync(FILE_PATH)) fs.unlinkSync(FILE_PATH);

        // ==========================================
        // PART 1: In-Memory / Persona Store Unit Tests
        // ==========================================

        await personaStore.load();

        // Invariant check: Active profile defaults to classic
        t.equal(personaStore.getActiveProfileId(), 'classic', 'Active profile should default to classic');
        assertionCount++;

        // Validate profiles list returns 2 profiles
        const states = personaStore.listProfileStates();
        t.equal(states.length, 2, 'Should list exactly 2 profile states');
        t.equal(states[0].id, 'classic', 'First listed profile state should be classic');
        t.equal(states[1].id, 'warm_guide', 'Second listed profile state should be warm_guide');
        assertionCount += 3;

        // Try atomic updates on profiles
        await personaStore.updateProfile('classic', {
            name: 'Alex Custom',
            identity: {
                background: 'Custom background story',
                interests: ['wine', 'travel']
            }
        });

        const classicOverrides = personaStore.getProfilesOverrides().classic?.overrides || {};
        t.equal(classicOverrides.name, 'Alex Custom', 'Updated name should match');
        t.equal(classicOverrides.identity?.background, 'Custom background story', 'Updated identity background should match');
        t.deepEqual(classicOverrides.identity?.interests, ['wine', 'travel'], 'Updated interests should match');
        assertionCount += 3;

        // Validation limits: interest array length
        try {
            await personaStore.updateProfile('classic', {
                identity: {
                    interests: new Array(20).fill('tag')
                }
            });
            assert.fail('Should have rejected interest array with > 15 elements');
        } catch (e) {
            t.match(e.message, /interests/i);
            assertionCount++;
        }

        // Validation: interest element length is truncated to 60 chars
        await personaStore.updateProfile('classic', {
            identity: {
                interests: ['a'.repeat(70)]
            }
        });
        const classicOverridesInterests = personaStore.getProfilesOverrides().classic?.overrides?.identity?.interests || [];
        t.equal(classicOverridesInterests[0].length, 60, 'Interest element should be truncated to 60 characters');
        assertionCount++;

        // Validation: identity field is truncated to 2000 chars
        await personaStore.updateProfile('classic', {
            identity: {
                background: 'a'.repeat(2100)
            }
        });
        const classicOverridesBg = personaStore.getProfilesOverrides().classic?.overrides?.identity?.background || '';
        t.equal(classicOverridesBg.length, 2000, 'Identity background should be truncated to 2000 characters');
        assertionCount++;

        // Validation: root override name is truncated to 80 chars
        await personaStore.updateProfile('classic', {
            name: 'a'.repeat(100)
        });
        const classicOverridesName = personaStore.getProfilesOverrides().classic?.overrides?.name || '';
        t.equal(classicOverridesName.length, 80, 'Root override name should be truncated to 80 characters');
        assertionCount++;

        // Reset Profile
        await personaStore.resetProfile('classic');
        const resetClassicOverrides = personaStore.getProfilesOverrides().classic?.overrides || {};
        t.deepEqual(resetClassicOverrides, {}, 'Reset profile overrides should be empty');
        assertionCount++;

        // Prompt Compiler Grounding Verification
        const customOverrides = {
            identity: {
                background: 'Special AI sommelier born in Moldova',
                selfAdvantages: 'Quick search',
                selfLimitations: 'No real tastebuds',
                interests: ['coding', 'wine']
            }
        };

        const effectivePrompt = getEffectivePersonaPrompt(customOverrides, 'classic', 'calm');
        t.ok(effectivePrompt.includes('Special AI sommelier born in Moldova'), 'Prompt should include custom origin story');
        t.ok(effectivePrompt.includes('Quick search'), 'Prompt should include custom selfAdvantages');
        t.ok(effectivePrompt.includes('No real tastebuds'), 'Prompt should include custom selfLimitations');
        t.ok(effectivePrompt.includes('coding, wine'), 'Prompt should include custom interests');
        assertionCount += 4;

        // ==========================================
        // PART 2: API integration / Server Tests
        // ==========================================

        if (fs.existsSync(FILE_PATH)) fs.unlinkSync(FILE_PATH);

        const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
            env: {
                ...process.env,
                PORT: String(PORT),
                PERSONA_OVERRIDES_FILE: FILE_PATH,
                DATABASE_URL: ''
            }
        });

        let stdoutData = '';
        let stderrData = '';
        child.stdout.on('data', (d) => { stdoutData += d; });
        child.stderr.on('data', (d) => { stderrData += d; });

        try {
            await waitServer();

            // GET /api/persona/profiles: contains hasCustomSettings
            const profsRes = await fetch(`${BASE}/api/persona/profiles`);
            const profsData = await profsRes.json();
            t.ok(profsData.ok);
            t.ok(Array.isArray(profsData.profiles));
            t.equal(profsData.profiles[0].hasCustomSettings, false, 'classic profile hasCustomSettings defaults to false');
            assertionCount += 3;

            // GET /api/persona: active state alexander (classic)
            const activeRes = await fetch(`${BASE}/api/persona`);
            const activeData = await activeRes.json();
            console.log('activeData response is:', activeData);
            t.ok(activeData.ok);
            t.equal(activeData.activeProfileId, 'classic', 'activeProfileId defaults to classic');
            t.equal(activeData.baseProfileId, 'classic', 'baseProfileId defaults to classic');
            assertionCount += 3;

            // POST /api/persona: update classic overrides
            const updateRes = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    profileId: 'classic',
                    overrides: {
                        name: 'Alexander Custom Name',
                        identity: {
                            background: 'My custom story text'
                        }
                    }
                })
            });
            const updateData = await updateRes.json();
            t.ok(updateData.ok);
            t.equal(updateData.overrides.name, 'Alexander Custom Name');
            t.equal(updateData.overrides.identity?.background, 'My custom story text');
            assertionCount += 3;

            // GET target profile /api/persona?profileId=classic returns overrides
            const classicRes = await fetch(`${BASE}/api/persona?profileId=classic`);
            const classicData = await classicRes.json();
            t.ok(classicData.ok);
            t.equal(classicData.overrides.name, 'Alexander Custom Name');
            assertionCount += 2;

            // GET active profile is still classic, but warm_guide overrides should be empty
            const guideRes = await fetch(`${BASE}/api/persona?profileId=warm_guide`);
            const guideData = await guideRes.json();
            t.ok(guideData.ok);
            t.deepEqual(guideData.overrides, {}, 'warm_guide overrides are clean');
            assertionCount += 2;

            // POST /api/persona/activate: activate warm_guide
            const actRes = await fetch(`${BASE}/api/persona/activate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    profileId: 'warm_guide'
                })
            });
            const actData = await actRes.json();
            t.ok(actData.ok);
            t.equal(actData.activeProfileId, 'warm_guide', 'activeProfileId switched to warm_guide');
            assertionCount += 2;

            // Verify active GET now reflects warm_guide
            const checkActiveRes = await fetch(`${BASE}/api/persona`);
            const checkActiveData = await checkActiveRes.json();
            t.equal(checkActiveData.activeProfileId, 'warm_guide');
            assertionCount++;

            // POST /api/persona/preview: preview overrides
            const previewRes = await fetch(`${BASE}/api/persona/preview`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    profileId: 'warm_guide',
                    overrides: {
                        name: 'Warm Preview Name',
                        identity: {
                            background: 'Background Preview Story'
                        }
                    }
                })
            });
            const previewData = await previewRes.json();
            t.ok(previewData.ok);
            t.ok(previewData.effectivePromptPreview.includes('Warm Preview Name'));
            t.ok(previewData.effectivePromptPreview.includes('Background Preview Story'));
            assertionCount += 3;

            // Verify preview had no side-effects (actual overrides for warm_guide remain empty)
            const guideCheckRes = await fetch(`${BASE}/api/persona?profileId=warm_guide`);
            const guideCheckData = await guideCheckRes.json();
            t.deepEqual(guideCheckData.overrides, {}, 'Actual overrides were not affected by preview');
            assertionCount++;

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

        // ==========================================
        // PART 3: Invariant Safety Check (Broken DB URL -> 503)
        // ==========================================

        const brokenDbChild = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
            env: {
                ...process.env,
                PORT: String(PORT),
                DATABASE_URL: 'postgresql://invalid_user:invalid_pwd@127.0.0.1:54321/invalid_db_name',
                PERSONA_OVERRIDES_FILE: FILE_PATH
            }
        });

        try {
            await waitServer();

            // Perform GET /api/persona, should return 503
            const dbFailRes = await fetch(`${BASE}/api/persona`);
            t.equal(dbFailRes.status, 503, 'Should return HTTP 503 when Postgres connection fails');
            assertionCount++;
        } finally {
            brokenDbChild.kill();
            await new Promise((resolveExit) => {
                brokenDbChild.on('exit', () => resolveExit());
            });
        }

    } finally {
        process.env.DATABASE_URL = origDbUrl;
        if (fs.existsSync(FILE_PATH)) fs.unlinkSync(FILE_PATH);
        if (backupExists && backupContent !== null) {
            fs.writeFileSync(FILE_PATH, backupContent, 'utf8');
        }
    }

    console.log(`[PASS] tests/personaIdentityGrounding.test.js: ${assertionCount} assertions passed.`);
}

module.exports = { run };

if (require.main === module) {
    run().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
