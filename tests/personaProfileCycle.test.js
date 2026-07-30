'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const t = require('./helpers/assertions');

const FILE_PATH = path.resolve(__dirname, '..', 'data', 'persona-overrides-test-tmp.json');
process.env.PERSONA_OVERRIDES_FILE = FILE_PATH;

const personaStore = require('../src/persona/personaStore');
const { listProfiles, getProfileById } = require('../src/persona/profileRegistry');

async function waitServer(url) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Server failed to start within 8s');
}

async function connectWs(port) {
  const ws = new WebSocket(`ws://localhost:${port}/realtime`);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WS connect timeout')), 5000);
    ws.on('open', () => { clearTimeout(timeout); resolve(); });
    ws.on('error', reject);
  });
  return ws;
}

function wsSend(ws, msg) {
  ws.send(JSON.stringify(msg));
}

function wsWaitFor(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`WS waitFor timeout after ${timeoutMs}ms`)), timeoutMs);
    const handler = (data) => {
      let parsed;
      try { parsed = JSON.parse(data.toString()); } catch { return; }
      if (predicate(parsed)) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        resolve(parsed);
      }
    };
    ws.on('message', handler);
  });
}

async function run() {
  let assertionCount = 0;

  const backupExists = fs.existsSync(FILE_PATH);
  let backupContent = null;
  if (backupExists) {
    backupContent = fs.readFileSync(FILE_PATH, 'utf8');
  }

  const origDbUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = '';

  let child = null;
  try {
    // Clean state
    if (fs.existsSync(FILE_PATH)) fs.unlinkSync(FILE_PATH);
    await personaStore.load();

    // ==========================================
    // PART 1: IN-PROCESS PROFILE OPERATIONS
    // ==========================================

    // Modify warm_guide profile
    await personaStore.updateProfile('warm_guide', {
      welcomeMessage: 'Custom welcome for warm_guide',
      personalityPrompt: 'Custom personality for warm_guide',
      systemPrompt: 'Custom system prompt for warm_guide',
      style: { responseLength: 'detailed', humorLevel: 'high' },
      runtimeByProvider: { gemini: { voiceId: 'Kore' }, grok: { voiceId: 'eve' } }
    });

    // Verify warm_guide has customProfileIds status
    const profilesStateBefore = personaStore.listProfileStates();
    const warmState = profilesStateBefore.find(s => s.id === 'warm_guide');
    t.ok(warmState, 'warm_guide state exists');
    t.equal(warmState.hasCustomSettings, true, 'warm_guide has custom settings');
    assertionCount += 2;

    // classic should still show no custom settings
    const classicState = profilesStateBefore.find(s => s.id === 'classic');
    t.equal(classicState.hasCustomSettings, false, 'classic has no custom settings');
    assertionCount += 1;

    // Verify overrides don't leak across profiles
    const classicOverrides = (personaStore.getProfilesOverrides().classic || {}).overrides || {};
    t.equal(classicOverrides.welcomeMessage, undefined, 'classic welcomeMessage not affected by warm_guide save');
    t.equal(classicOverrides.style, undefined, 'classic style not affected by warm_guide save');
    assertionCount += 2;

    // Reset warm_guide to clean state
    await personaStore.resetProfile('warm_guide');
    const warmAfterReset = (personaStore.getProfilesOverrides().warm_guide || {}).overrides || {};
    t.deepEqual(warmAfterReset, {}, 'warm_guide overrides reset to empty');
    assertionCount += 1;

    // ==========================================
    // PART 2: HTTP SERVER PROFILE CYCLE
    // ==========================================

    child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: '0',
        DATABASE_URL: '',
        PERSONA_OVERRIDES_FILE: FILE_PATH,
      }
    });

    let serverStdout = '';
    let serverStderr = '';
    child.stdout.on('data', d => { serverStdout += d.toString(); });
    child.stderr.on('data', d => { serverStderr += d.toString(); });

    let resolvedPort;
    const portFromOutput = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server did not report port')), 10000);
      const checkOutput = (data) => {
        const m = data.toString().match(/listening port=(\d+)/i);
        if (m) { clearTimeout(timeout); resolve(Number(m[1])); }
      };
      child.stdout.on('data', checkOutput);
      child.stderr.on('data', checkOutput);
    });

    resolvedPort = await portFromOutput;

    const BASE = `http://localhost:${resolvedPort}`;
    await waitServer(BASE);

    // Step A: Load classic profile
    const getClassicRes = await fetch(`${BASE}/api/persona?profileId=classic`);
    t.equal(getClassicRes.status, 200, 'GET classic returns 200');
    const classic = await getClassicRes.json();
    t.equal(classic.profileId, 'classic', 'loaded profile is classic');
    t.equal(classic.customizationMode, 'preset', 'classic is preset mode');
    t.ok(Array.isArray(classic.customProfileIds), 'customProfileIds is array');
    t.equal(classic.customProfileIds.includes('classic'), false, 'classic not in customProfileIds');
    assertionCount += 4;

    // Step B: Save overrides to classic
    const saveClassicRes = await fetch(`${BASE}/api/persona`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileId: 'classic',
        overrides: {
          welcomeMessage: 'Hello from test',
          personalityPrompt: 'Test personality',
          systemPrompt: 'Test system prompt',
          style: { responseLength: 'short' }
        }
      }),
    });
    t.equal(saveClassicRes.status, 200, 'POST classic save returns 200');
    const saved = await saveClassicRes.json();
    t.equal(saved.customizationMode, 'custom', 'classic becomes custom after save');
    t.ok(saved.customProfileIds.includes('classic'), 'classic now in customProfileIds');
    assertionCount += 3;

    // Step C: Reload classic — verify overrides persisted
    const reloadClassicRes = await fetch(`${BASE}/api/persona?profileId=classic`);
    t.equal(reloadClassicRes.status, 200, 'reload classic returns 200');
    const reloaded = await reloadClassicRes.json();
    t.equal(reloaded.overrides.welcomeMessage, 'Hello from test', 'welcomeMessage persisted');
    t.equal(reloaded.overrides.personalityPrompt, 'Test personality', 'personalityPrompt persisted');
    t.equal(reloaded.overrides.systemPrompt, 'Test system prompt', 'systemPrompt persisted');
    t.equal(reloaded.overrides.style.responseLength, 'short', 'style persisted');
    assertionCount += 4;

    // Step D: warm_guide remained clean
    const getGuideRes = await fetch(`${BASE}/api/persona?profileId=warm_guide`);
    t.equal(getGuideRes.status, 200, 'GET warm_guide returns 200');
    const guide = await getGuideRes.json();
    t.equal(guide.customizationMode, 'preset', 'warm_guide is still preset');
    t.equal(guide.customProfileIds.includes('warm_guide'), false, 'warm_guide not in customProfileIds');
    assertionCount += 3;

    // Step E: Save warm_guide overrides
    await fetch(`${BASE}/api/persona`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileId: 'warm_guide',
        overrides: {
          welcomeMessage: 'Warm welcome',
          style: { responseLength: 'detailed', humorLevel: 'high' },
          runtimeByProvider: { gemini: { voiceId: 'Kore' } }
        }
      }),
    });

    // Step F: Verify classic still has its original overrides (no cross-contamination)
    const verifyClassicRes = await fetch(`${BASE}/api/persona?profileId=classic`);
    const verifyClassic = await verifyClassicRes.json();
    t.equal(verifyClassic.overrides.welcomeMessage, 'Hello from test', 'classic welcomeMessage unchanged after warm_guide save');
    t.equal(verifyClassic.overrides.style.responseLength, 'short', 'classic style unchanged after warm_guide save');
    t.equal(verifyClassic.overrides.runtimeByProvider, undefined, 'classic runtimeByProvider unchanged');
    assertionCount += 3;

    // Step G: Verify warm_guide overrides are correct
    const verifyGuideRes = await fetch(`${BASE}/api/persona?profileId=warm_guide`);
    const verifyGuide = await verifyGuideRes.json();
    t.equal(verifyGuide.overrides.welcomeMessage, 'Warm welcome', 'warm_guide welcomeMessage correct');
    t.equal(verifyGuide.overrides.style.responseLength, 'detailed', 'warm_guide style correct');
    t.equal(verifyGuide.overrides.runtimeByProvider.gemini.voiceId, 'Kore', 'warm_guide runtimeByProvider correct');
    t.ok(verifyGuide.customProfileIds.includes('warm_guide'), 'warm_guide in customProfileIds');
    assertionCount += 4;

    // Step H: Resolve profile via session.start — verify runtime snapshot
    // Activate classic first (it has custom overrides)
    const activateRes = await fetch(`${BASE}/api/persona/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'classic' }),
    });
    t.equal(activateRes.status, 200, 'activate returns 200');
    const activated = await activateRes.json();
    t.equal(activated.activeProfileId, 'classic', 'active profile is classic');
    t.equal(activated.mood, 'calm', 'mood is default calm');
    t.ok(Array.isArray(activated.customProfileIds), 'customProfileIds in activate response');
    assertionCount += 3;

    // Step I: WebSocket session.start with classic profile
    const ws = await connectWs(resolvedPort);
    await wsWaitFor(ws, (e) => e.type === 'session.ready');

    wsSend(ws, { type: 'session.start', sampleRate: 16000, include_prompt_debug: true });
    const applied = await wsWaitFor(ws, (e) => e.type === 'session.config.applied');
    t.equal(applied.type, 'session.config.applied', 'session.config.applied received');
    t.ok(applied.prompt_debug, 'prompt_debug present');
    t.ok(applied.prompt_debug.applied_blocks, 'prompt_debug.applied_blocks present');
    // The effective prompt should contain classic's custom welcome (from overrides)
    const appliedPersona = applied.prompt_debug.applied_blocks.persona;
    t.ok(appliedPersona.includes('Hello from test'), 'session prompt includes classic custom welcomeMessage');
    t.ok(appliedPersona.includes('Test personality'), 'session prompt includes classic custom personalityPrompt');
    assertionCount += 4;

    // Step J: Activate warm_guide, send new session.start — verify snapshot rebuilt
    const activateGuideRes = await fetch(`${BASE}/api/persona/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'warm_guide' }),
    });
    t.equal(activateGuideRes.status, 200, 'activate warm_guide returns 200');
    const activatedGuide = await activateGuideRes.json();
    t.equal(activatedGuide.activeProfileId, 'warm_guide', 'active profile switched to warm_guide');
    t.equal(activatedGuide.customProfileIds.includes('warm_guide'), true, 'warm_guide in customProfileIds');
    t.equal(activatedGuide.customProfileIds.includes('classic'), true, 'classic still in customProfileIds');
    assertionCount += 4;

    // Send new session.start — snapshot must be rebuilt with warm_guide
    wsSend(ws, { type: 'session.start', sampleRate: 16000, include_prompt_debug: true });
    const appliedGuide = await wsWaitFor(ws, (e) => e.type === 'session.config.applied');

    // The prompt should now contain warm_guide's custom welcome, not classic's
    const guidePersona = appliedGuide.prompt_debug.applied_blocks.persona;
    t.ok(!guidePersona.includes('Hello from test'), 'session prompt no longer contains classic welcome');
    t.ok(guidePersona.includes('Warm welcome'), 'session prompt includes warm_guide welcome');
    t.ok(guidePersona.includes('профессионально'), 'session prompt still includes base persona content');
    assertionCount += 3;

    ws.close();

    console.log(`[PASS] tests/personaProfileCycle.test.js: All ${assertionCount} assertions passed successfully.`);
  } finally {
    // Cleanup
    if (child && !child.killed) {
      child.kill();
      await new Promise(r => setTimeout(r, 200));
    }
    process.env.DATABASE_URL = origDbUrl;
    if (backupContent !== null) {
      fs.writeFileSync(FILE_PATH, backupContent, 'utf8');
    } else if (fs.existsSync(FILE_PATH)) {
      fs.unlinkSync(FILE_PATH);
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
