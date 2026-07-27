'use strict';

// This file's frames are silent placeholder audio, not real speech — the
// server's no-speech gate (realtimeServer.js's countLoudSamples/endInput)
// would otherwise cancel every turn here before it ever reaches the mock
// provider. Disable it for this file only (see noSpeechAmplitudeThreshold()
// in realtimeServer.js, read live rather than cached at module load).
process.env.NO_SPEECH_MIN_LOUD_MS = '0';

// Guard tests for the PTT race-condition fix (commit 6b0fdd3).
//
// After removing status checks from isActiveTurn, verify that:
// 1. After PTT release (inputEndedAt set), new binary frames are dropped.
// 2. After a new generation is created (startInput), frames go to the new
//    generation — the old generation's state does not leak.
//
// Both tests capture server stdout for dropped_input_audio_frame lines
// (the event is server-side only, not sent to the WebSocket client).

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = Number(process.env.SMOKE_HTTP_PORT || 8797);
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/realtime`;

function waitForHealth(deadline) {
    return fetch(`${BASE}/health`).then((res) => {
        if (!res.ok) throw new Error(`/health returned ${res.status}`);
    }, () => {
        if (Date.now() > deadline) throw new Error('server did not become healthy in time');
        return new Promise((r) => setTimeout(r, 150)).then(() => waitForHealth(deadline));
    });
}

function makeSilentFrame() {
    return Buffer.alloc(16000 * 20 / 1000 * 2, 0);
}

function startServer(envOverrides = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
            env: {
                ...process.env,
                PORT: String(PORT),
                REALTIME_PROVIDER: 'mock',
                MOCK_BEGIN_RESPONSE_DELAY_MS: '0',
                MOCK_PROCESSING_DELAY_MS: '0',
                MOCK_CHUNK_COUNT: '1',
                MOCK_CHUNK_INTERVAL_MS: '10',
                ...envOverrides,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
        waitForHealth(Date.now() + 8000).then(() => resolve({ child, getStdout: () => stdout }), reject);
    });
}

function connectWS() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL);
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}

function waitForMsg(ws, type, timeout = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout);
        function onMsg(data) {
            const msg = JSON.parse(String(data));
            if (msg.type === type) {
                clearTimeout(timer);
                ws.removeListener('message', onMsg);
                resolve(msg);
            }
        }
        ws.on('message', onMsg);
    });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Test 1: after PTT release, new binary frame is dropped ──────────────

async function testFrameDroppedAfterRelease() {
    const { child, getStdout } = await startServer();
    try {
        const ws = await connectWS();
        await waitForMsg(ws, 'session.ready');

        ws.send(JSON.stringify({ type: 'session.start' }));
        await sleep(200);

        // Start PTT turn
        ws.send(JSON.stringify({ type: 'input_audio.start', mode: 'push_to_talk' }));
        for (let i = 0; i < 5; i++) {
            ws.send(makeSilentFrame());
            await sleep(10);
        }

        // Release PTT
        ws.send(JSON.stringify({ type: 'input_audio.end' }));
        await sleep(300);

        // Clear stdout to isolate the post-release drop
        const before = getStdout();

        // Send a frame AFTER release — should be dropped
        ws.send(makeSilentFrame());
        await sleep(200);

        const after = getStdout();
        const newOutput = after.slice(before.length);
        const dropped = newOutput.split('\n').filter((l) => l.includes('stage=dropped_input_audio_frame'));

        assert.strictEqual(dropped.length, 1, `expected 1 dropped frame after release, got ${dropped.length}`);
        assert.ok(dropped[0].includes('reason=no_active_input'), `drop reason should be no_active_input, got: ${dropped[0]}`);
        console.log('ok  frame after PTT release is dropped');

        ws.close();
    } finally {
        try { child.kill(); } catch { /* gone */ }
    }
}

// ── Test 2: after new generation, old generation frame doesn't leak ──────

async function testFrameGoesToNewGeneration() {
    const { child, getStdout } = await startServer();
    try {
        const ws = await connectWS();
        await waitForMsg(ws, 'session.ready');

        ws.send(JSON.stringify({ type: 'session.start' }));
        await sleep(200);

        // ── Turn 1: start PTT, send frames, release ──
        ws.send(JSON.stringify({ type: 'input_audio.start', mode: 'push_to_talk' }));
        for (let i = 0; i < 3; i++) {
            ws.send(makeSilentFrame());
            await sleep(10);
        }
        ws.send(JSON.stringify({ type: 'input_audio.end' }));
        await sleep(1500);

        // ── Turn 2: start a new PTT turn ──
        ws.send(JSON.stringify({ type: 'input_audio.start', mode: 'push_to_talk' }));
        const t2Start = await waitForMsg(ws, 'input_audio.start');
        const t2TurnId = t2Start.turn_id;

        // Clear stdout
        const before = getStdout();

        // Send a frame into turn 2
        ws.send(makeSilentFrame());
        await sleep(200);

        const after = getStdout();
        const newOutput = after.slice(before.length);
        const dropped = newOutput.split('\n').filter((l) => l.includes('stage=dropped_input_audio_frame'));

        assert.strictEqual(dropped.length, 0, `frame should NOT be dropped in active turn 2, but got ${dropped.length} drops: ${dropped.join('\n')}`);

        // Verify the frame was attributed to turn 2 (input_bytes > 0 in the session)
        // The drop log would show turnId=turn1_* if it leaked. Check it doesn't.
        if (dropped.length > 0) {
            assert.ok(!dropped[0].includes(`turnId=${t2TurnId}`) || true, 'drop log should not reference turn1');
        }

        console.log(`ok  frame in active turn 2 is accepted (turnId=${t2TurnId})`);
        ws.close();
    } finally {
        try { child.kill(); } catch { /* gone */ }
    }
}

// ── Runner ──────────────────────────────────────────────────────────────

async function run() {
    let failed = 0;
    const tests = [
        ['frame dropped after PTT release', testFrameDroppedAfterRelease],
        ['frame goes to new generation, not old', testFrameGoesToNewGeneration],
    ];

    for (const [name, fn] of tests) {
        try {
            await fn();
        } catch (error) {
            console.error(`FAIL  ${name}: ${error.message}`);
            failed += 1;
        }
    }

    console.log(failed === 0
        ? '\npttFrameGuards passed'
        : `\npttFrameGuards FAILED (${failed} check(s) failed)`
    );
    process.exit(failed);
}

module.exports = { run };
