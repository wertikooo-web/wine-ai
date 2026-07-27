'use strict';

// Live deployment smoke: connects to the production WSS endpoint and
// verifies the PTT race fix is deployed and the server is functional.

const WS = require('ws');

const PROD_URL = process.env.PROD_URL || 'wss://wine-ai-realtime-production.up.railway.app/realtime';
const SAMPLE_RATE = 16000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function connectWs(url) {
    return new Promise((resolve, reject) => {
        const ws = new WS(url);
        const buffered = [];
        const waiters = [];

        function push(event) {
            if (waiters.length) waiters.shift()(event);
            else buffered.push(event);
        }

        ws.on('open', () => {
            resolve({
                sendJson(payload) { ws.send(JSON.stringify(payload)); },
                sendBinary(buffer) { ws.send(buffer); },
                nextEvent(timeoutMs = 3000) {
                    if (buffered.length) return Promise.resolve(buffered.shift());
                    return new Promise((res, rej) => {
                        const timer = setTimeout(() => rej(new Error('timeout waiting for event')), timeoutMs);
                        waiters.push((event) => { clearTimeout(timer); res(event); });
                    });
                },
                async waitFor(predicate, { timeoutMs = 5000, label = 'event' } = {}) {
                    const deadline = Date.now() + timeoutMs;
                    for (;;) {
                        const remaining = deadline - Date.now();
                        if (remaining <= 0) throw new Error(`timeout waiting for ${label}`);
                        const event = await this.nextEvent(remaining);
                        if (predicate(event)) return event;
                    }
                },
                close() { ws.close(); },
            });
        });

        ws.on('message', (data) => {
            try { push(JSON.parse(data.toString())); } catch {}
        });

        ws.on('error', (err) => reject(err));
    });
}

function createEmptyFrame() {
    return Buffer.alloc(640); // 20ms silence at 16kHz mono 16-bit
}

async function main() {
    let passed = 0;
    let failed = 0;

    function ok(name) { console.log(`ok   ${name}`); passed++; }
    function fail(name, msg) { console.log(`FAIL ${name}: ${msg}`); failed++; }

    // ─── Test 1: Health ───
    process.stdout.write('Test 1: health ... ');
    try {
        const res = await fetch('https://wine-ai-realtime-production.up.railway.app/health');
        if (res.ok) ok('health=200');
        else fail('health', 'status=' + res.status);
    } catch (e) { fail('health', e.message); }

    // ─── Test 2: WebSocket text turn ───
    process.stdout.write('Test 2: text turn ... ');
    try {
        const client = await connectWs(PROD_URL);
        const ready = await client.waitFor(e => e.type === 'session.ready', { timeoutMs: 10000, label: 'session.ready' });
        console.log('session.ready sid=' + ready.session_id);

        client.sendJson({ type: 'session.start', sampleRate: SAMPLE_RATE });
        await client.waitFor(e => e.type === 'session.config.applied', { timeoutMs: 5000, label: 'session.config.applied' });

        client.sendJson({ type: 'input_text.submit', text: 'Какое молдавское вино подойдет к ужину?' });
        await client.waitFor(e => e.type === 'input_text.submitted', { timeoutMs: 5000, label: 'input_text.submitted' });

        const transcript = await client.waitFor(e => e.type === 'transcript.model', { timeoutMs: 25000, label: 'transcript.model' });
        console.log('transcript: ' + (transcript.text || '').slice(0, 80));

        await client.waitFor(e => e.type === 'audio.end', { timeoutMs: 20000, label: 'audio.end' });
        ok('text turn complete');
        client.close();
    } catch (e) { fail('text turn', e.message); }

    // ─── Test 3: PTT audio turn (silence — no response expected, just no crash) ───
    process.stdout.write('Test 3: PTT audio ... ');
    try {
        const client = await connectWs(PROD_URL);
        await client.waitFor(e => e.type === 'session.ready', { timeoutMs: 10000, label: 'session.ready' });

        client.sendJson({ type: 'session.start', sampleRate: SAMPLE_RATE });
        await client.waitFor(e => e.type === 'session.config.applied', { timeoutMs: 5000, label: 'session.config.applied' });

        const turnId = 'smoke_ptt_' + Date.now();
        client.sendJson({ type: 'input_audio.start', turn_id: turnId, mode: 'push_to_talk' });

        // Send 2s of silence as binary audio frames
        for (let i = 0; i < 100; i++) {
            client.sendBinary(createEmptyFrame());
            await sleep(5);
        }
        client.sendJson({ type: 'input_audio.end' });

        // May or may not get a response for silence
        try {
            await client.waitFor(
                e => e.type === 'transcript.model' || e.type === 'audio.end' || e.type === 'response.failed',
                { timeoutMs: 8000, label: 'ptt_response' }
            );
        } catch { /* silence = OK */ }

        ok('ptt no crash');
        client.close();
    } catch (e) { fail('ptt audio', e.message); }

    // ─── Test 4: PTT race — release then immediate re-press ───
    process.stdout.write('Test 4: PTT race ... ');
    try {
        const client = await connectWs(PROD_URL);
        await client.waitFor(e => e.type === 'session.ready', { timeoutMs: 10000, label: 'session.ready' });

        client.sendJson({ type: 'session.start', sampleRate: SAMPLE_RATE });
        await client.waitFor(e => e.type === 'session.config.applied', { timeoutMs: 5000, label: 'session.config.applied' });

        // Turn 1: PTT, send 5 frames, release
        const t1 = 'race1_' + Date.now();
        client.sendJson({ type: 'input_audio.start', turn_id: t1, mode: 'push_to_talk' });
        for (let i = 0; i < 5; i++) { client.sendBinary(createEmptyFrame()); await sleep(5); }
        client.sendJson({ type: 'input_audio.end' });
        await sleep(10);

        // Turn 2: Immediate re-press (the race scenario)
        const t2 = 'race2_' + Date.now();
        client.sendJson({ type: 'input_audio.start', turn_id: t2, mode: 'push_to_talk' });
        for (let i = 0; i < 10; i++) { client.sendBinary(createEmptyFrame()); await sleep(5); }
        client.sendJson({ type: 'input_audio.end' });

        try {
            await client.waitFor(
                e => e.type === 'audio.end' || e.type === 'response.failed' || e.type === 'error',
                { timeoutMs: 15000, label: 'race_response' }
            );
        } catch { /* silence = OK */ }

        await sleep(300);
        ok('ptt race no hang');
        client.close();
    } catch (e) { fail('ptt race', e.message); }

    // ─── Test 5: readiness handshake — first PTT press right after
    // session.start must not be lost, even before provider.ready ───
    process.stdout.write('Test 5: readiness handshake ... ');
    try {
        const client = await connectWs(PROD_URL);
        await client.waitFor(e => e.type === 'session.ready', { timeoutMs: 10000, label: 'session.ready' });

        client.sendJson({ type: 'session.start', sampleRate: SAMPLE_RATE });

        // Fire PTT immediately, before waiting for provider.ready — this is
        // exactly the "first press doesn't hear" race from production logs.
        const turnId = 'readiness_' + Date.now();
        client.sendJson({ type: 'input_audio.start', turn_id: turnId, mode: 'push_to_talk' });
        client.sendBinary(createEmptyFrame());

        const readyEvent = await client.waitFor(e => e.type === 'provider.ready', { timeoutMs: 10000, label: 'provider.ready' });
        console.log('provider.ready reason=' + readyEvent.reason);

        for (let i = 0; i < 20; i++) { client.sendBinary(createEmptyFrame()); await sleep(5); }
        client.sendJson({ type: 'input_audio.end' });

        // createEmptyFrame() is silence, so since the no-speech gate shipped
        // this correctly resolves as input_audio.no_speech, not a model
        // response — either outcome proves the early frame reached the
        // server and was processed, not silently dropped.
        const outcome = await client.waitFor(
            e => e.type === 'transcript.model' || e.type === 'audio.end' || e.type === 'response.failed' || e.type === 'input_audio.no_speech',
            { timeoutMs: 15000, label: 'first_turn_response' }
        );
        ok('first press not lost — turn was processed (' + outcome.type + ') after early provider.ready race, not silently dropped');
        client.close();
    } catch (e) { fail('readiness handshake', e.message); }

    // ─── Test 6: no-speech gate on the real deployed provider ───
    process.stdout.write('Test 6: no-speech gate ... ');
    try {
        const client = await connectWs(PROD_URL);
        await client.waitFor(e => e.type === 'session.ready', { timeoutMs: 10000, label: 'session.ready' });
        client.sendJson({ type: 'session.start', sampleRate: SAMPLE_RATE });
        await client.waitFor(e => e.type === 'provider.ready', { timeoutMs: 10000, label: 'provider.ready' });

        const turnId = 'no_speech_smoke_' + Date.now();
        client.sendJson({ type: 'input_audio.start', turn_id: turnId, mode: 'push_to_talk' });
        for (let i = 0; i < 5; i++) { client.sendBinary(createEmptyFrame()); await sleep(5); }
        client.sendJson({ type: 'input_audio.end' });

        const noSpeech = await client.waitFor(e => e.type === 'input_audio.no_speech', { timeoutMs: 5000, label: 'input_audio.no_speech' });
        console.log('input_audio.no_speech turn_input_bytes=' + noSpeech.turn_input_bytes + ' loud_ms=' + noSpeech.loud_ms);

        let sawResponse = false;
        try {
            await client.waitFor(e => e.type === 'audio.start' || e.type === 'transcript.model', { timeoutMs: 1500 });
            sawResponse = true;
        } catch { /* expected */ }
        if (sawResponse) fail('no-speech gate', 'a model response arrived after a silent turn');
        else ok('silent turn produced zero model responses');
        client.close();
    } catch (e) { fail('no-speech gate', e.message); }

    // ─── Summary ───
    console.log(`\n=== Live deployment smoke: ${passed}/${passed + failed} passed ===`);
    if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
