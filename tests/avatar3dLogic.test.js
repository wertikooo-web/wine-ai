'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

async function importAvatarModule(name) {
    const file = path.join(__dirname, '..', 'public', 'avatar', name);
    return import(pathToFileURL(file).href);
}

async function run() {
    const state = await importAvatarModule('AvatarStateAdapter.mjs');
    const lip = await importAvatarModule('lipSync.mjs');
    let assertionCount = 0;

    assert.strictEqual(state.toAvatarState('ready'), 'idle'); assertionCount += 1;
    assert.strictEqual(state.toAvatarState('speaking'), 'talking'); assertionCount += 1;
    assert.strictEqual(state.toAvatarState('listening'), 'listening'); assertionCount += 1;
    assert.strictEqual(state.toAvatarState('unknown'), 'idle'); assertionCount += 1;
    assert.strictEqual(state.isSpeakingState('speaking'), true); assertionCount += 1;

    assert.strictEqual(lip.clamp01(-1), 0); assertionCount += 1;
    assert.strictEqual(lip.clamp01(2), 1); assertionCount += 1;
    assert.ok(Math.abs(lip.rmsFromTimeDomain(new Float32Array([1, -1])) - 1) < 1e-6); assertionCount += 1;
    const attackMovement = lip.smoothAmplitude(0, 1, 0.5, 0.1);
    const releaseMovement = 1 - lip.smoothAmplitude(1, 0, 0.5, 0.1);
    assert.ok(attackMovement > releaseMovement); assertionCount += 1;

    const analyser = {
        fftSize: 4,
        getFloatTimeDomainData(target) { target.set([0.2, -0.2, 0.2, -0.2]); },
    };
    const driver = new lip.AmplitudeLipSyncDriver({ sensitivity: 5, noiseGate: 0.01, attack: 1, release: 1 });
    driver.attach(analyser);
    assert.ok(driver.sample(true) > 0.5); assertionCount += 1;
    assert.strictEqual(driver.sample(false), 0); assertionCount += 1;
    driver.sample(true);
    driver.reset();
    assert.strictEqual(driver.value, 0); assertionCount += 1;

    return { assertionCount };
}

module.exports = { run };
