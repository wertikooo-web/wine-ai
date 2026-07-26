'use strict';

// Regression: PTT input frames are dropped when the provider completes its
// response while the user is still holding the PTT button.
//
// Root cause: isActiveTurn in onBinary includes status !== 'completed'.
// When the provider emits audio.end (setting generation.status = 'completed')
// while the user is still sending frames, isActiveTurn becomes false and
// all subsequent frames are dropped with reason=no_active_input — even
// though inputEndedAt is 0 (the user never released the button).
//
// The mock provider's beginResponse() (triggered by startInput) auto-responds
// after MOCK_BEGIN_RESPONSE_DELAY_MS, simulating a real provider that starts
// generating while the user is still speaking. This triggers the race.
//
// Detection: the server logs dropped_input_audio_frame lines to stdout.
// We capture server stdout and count those lines.
//
// Expected: in PTT mode, audio frames keep flowing as long as the user
// holds the button, regardless of whether the provider has finished its
// response. Only input_audio.end (user release) should end input.

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
    // 20ms of silence at 16kHz mono PCM16
    return Buffer.alloc(16000 * 20 / 1000 * 2, 0);
}

async function run() {
    let failed = 0;
    let child;

    try {
        // Start server with fast mock that auto-responds via beginResponse()
        // 100ms after startInput, while user is still holding PTT.
        child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
            env: {
                ...process.env,
                PORT: String(PORT),
                REALTIME_PROVIDER: 'mock',
                MOCK_BEGIN_RESPONSE_DELAY_MS: '100',
                MOCK_PROCESSING_DELAY_MS: '0',
                MOCK_CHUNK_COUNT: '2',
                MOCK_CHUNK_INTERVAL_MS: '20',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Capture server stdout to detect dropped_input_audio_frame log lines
        let serverStdout = '';
        child.stdout.on('data', (chunk) => { serverStdout += String(chunk); });

        await waitForHealth(Date.now() + 8000);
        console.log('ok  server healthy');

        // Connect WebSocket
        const ws = new WebSocket(WS_URL);
        await new Promise((resolve, reject) => {
            ws.on('open', resolve);
            ws.on('error', reject);
        });
        console.log('ok  WebSocket connected');

        // Wait for session.ready
        const ready = await new Promise((resolve) => {
            ws.on('message', function onMsg(data) {
                const msg = JSON.parse(String(data));
                if (msg.type === 'session.ready') {
                    ws.removeListener('message', onMsg);
                    resolve(msg);
                }
            });
        });
        assert.strictEqual(ready.type, 'session.ready');
        console.log('ok  session.ready received');

        // Send session.start
        ws.send(JSON.stringify({ type: 'session.start' }));
        await new Promise((r) => setTimeout(r, 200));

        // ---- TURN 1: normal PTT cycle to warm up ----
        ws.send(JSON.stringify({ type: 'input_audio.start', mode: 'push_to_talk' }));
        for (let i = 0; i < 5; i++) {
            ws.send(makeSilentFrame());
            await new Promise((r) => setTimeout(r, 10));
        }
        ws.send(JSON.stringify({ type: 'input_audio.end' }));
        await new Promise((r) => setTimeout(r, 2000));
        console.log('ok  turn1 completed');

        // ---- TURN 2: the race condition ----
        // Clear server stdout to isolate turn2's drops
        serverStdout = '';

        // User presses PTT (startInput triggers beginResponse -> auto-respond after 100ms)
        ws.send(JSON.stringify({ type: 'input_audio.start', mode: 'push_to_talk' }));

        // Send frames continuously while mock auto-responds mid-stream
        let framesSent = 0;
        for (let i = 0; i < 40; i++) {
            ws.send(makeSilentFrame());
            framesSent += 1;
            await new Promise((r) => setTimeout(r, 50));
        }

        // Wait for any remaining server processing
        await new Promise((r) => setTimeout(r, 500));

        // Count dropped frames from server logs
        const dropLines = serverStdout.split('\n').filter((l) => l.includes('stage=dropped_input_audio_frame'));
        const droppedFrames = dropLines.length;

        // Also check for audio.end in server logs (confirms response completed)
        const audioEndLines = serverStdout.split('\n').filter((l) => l.includes('stage=audio_end'));
        console.log(`  framesSent=${framesSent} droppedFrames=${droppedFrames} audioEndCount=${audioEndLines.length}`);

        // THE ASSERTION: frames should NOT be dropped while user holds PTT,
        // even after the provider has finished its response.
        if (droppedFrames > 0) {
            console.error(`  FAIL: ${droppedFrames} frames dropped with reason=no_active_input`);
            console.error('  First drop:', dropLines[0]?.trim());
            failed = 1;
        } else {
            console.log('ok  no frames dropped during active PTT after response completion');
        }

        ws.close();

    } catch (error) {
        console.error('FAIL', error.message);
        failed = 1;
    } finally {
        try { child.kill(); } catch { /* already gone */ }
    }

    console.log(failed === 0
        ? '\npttRaceInputDrop passed'
        : `\npttRaceInputDrop FAILED (${failed} check(s) failed)`
    );
    process.exit(failed);
}

module.exports = { run };
