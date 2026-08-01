'use strict';

// Regression coverage for the barge-in fix (double-voice / "can't interrupt
// mid-response" bug): both Hold to Talk (pointerdown) and Free Conversation
// (confirmed local VAD) must immediately stop local playback, invalidate
// in-flight decodes, and prevent a stale/late server signal for the OLD
// generation from either (a) never stopping local audio at all, or (b)
// stopping the NEW generation's already-started playback.
//
// Uses the same sandbox-via-vm pattern as dashboardConnectionAndVoiceMode.test.js
// (extract dashboard.html's inline <script>, run it in a vm context with a
// minimal mock DOM/fetch/WebSocket/AudioContext) so real dashboard.html code
// is exercised, not a reimplementation of it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function run() {
    console.log('Running Dashboard Barge-In Tests...');

    const htmlPath = path.join(__dirname, '../public/dashboard.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    const startIndex = htmlContent.lastIndexOf('<script>');
    const endIndex = htmlContent.lastIndexOf('</script>');
    if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
        throw new Error('Could not find inline <script> block in dashboard.html');
    }
    const scriptText = htmlContent.substring(startIndex + 8, endIndex);

    let cleanText = scriptText;
    cleanText = cleanText.replace('(function () {', '');
    cleanText = cleanText.replace("'use strict';", '');
    const lastIndex = cleanText.lastIndexOf('})();');
    if (lastIndex !== -1) {
        cleanText = cleanText.substring(0, lastIndex) + cleanText.substring(lastIndex + 5);
    }

    function setLexical(sandbox, varName, value) {
        sandbox._tmpVal = value;
        vm.runInContext(`${varName} = _tmpVal; delete _tmpVal;`, sandbox);
    }
    function getLexical(sandbox, expr) {
        return vm.runInContext(expr, sandbox);
    }

    // ---- Minimal mock Web Audio graph ----
    // Real enough to exercise schedulePlayback()/stopPlaybackWithFadeOut()'s
    // actual gain-scheduling and source lifecycle, without needing a real
    // browser/audio device.
    function makeMockAudioContext() {
        let currentTime = 0;
        const ctx = {
            destination: { id: 'destination' },
            createBufferSource() {
                const src = {
                    buffer: null,
                    onended: null,
                    started: false,
                    stopped: false,
                    connect(dest) { src.connectedTo = dest; },
                    disconnect() { src.connectedTo = null; },
                    start(at) { src.started = true; src.startAt = at; },
                    stop() { src.stopped = true; },
                };
                return src;
            },
            createGain() {
                const scheduled = [];
                const gainParam = {
                    value: 1,
                    setValueAtTime(v, t) { gainParam.value = v; scheduled.push(['setValueAtTime', v, t]); },
                    linearRampToValueAtTime(v, t) { scheduled.push(['linearRampToValueAtTime', v, t]); },
                    cancelScheduledValues(t) { scheduled.push(['cancelScheduledValues', t]); },
                };
                return { gain: gainParam, scheduled, connect() {}, disconnect() {} };
            },
            createBuffer(channels, length, sampleRate) {
                return { duration: length / sampleRate, length, sampleRate, getChannelData: () => new Float32Array(length) };
            },
            createAnalyser() {
                return { fftSize: 0, smoothingTimeConstant: 0, connect() {}, disconnect() {} };
            },
            createMediaStreamSource() { return {}; },
            decodeAudioData() { return new Promise(() => {}); }, // never resolves unless overridden per-test
            close() { return Promise.resolve(); },
            get currentTime() { return currentTime; },
            _advance(sec) { currentTime += sec; },
        };
        return ctx;
    }

    function createTestSandbox() {
        const listeners = {};
        const elements = {};
        const timers = []; // { fn, ms } captured instead of actually scheduled

        function getMockElement(id) {
            if (!elements[id]) {
                elements[id] = {
                    id, value: '', textContent: '', innerHTML: '', disabled: false, hidden: false,
                    style: {}, dataset: {}, className: '',
                    classList: { add() {}, remove() {}, toggle() {} },
                    children: [], listeners: {},
                    addEventListener(event, handler) { this.listeners[event] = handler; listeners[`${id}_${event}`] = handler; },
                    appendChild(child) { this.children.push(child); },
                    append(...nodes) { this.children.push(...nodes); },
                    setAttribute(k, v) { this[k] = v; },
                    removeAttribute(k) { delete this[k]; },
                    remove() { this.removed = true; },
                    querySelectorAll() { return []; },
                };
            }
            return elements[id];
        }

        const mockDocument = {
            getElementById: getMockElement,
            addEventListener(event, handler) { listeners[`document_${event}`] = handler; },
            createTextNode(text) { return { text }; },
            querySelector(selector) { return selector.startsWith('#') ? getMockElement(selector.slice(1)) : null; },
            querySelectorAll() { return []; },
            createElement(tagName) {
                return {
                    tagName: tagName.toUpperCase(), children: [], textContent: '', style: {}, className: '',
                    append(...nodes) { this.children.push(...nodes); },
                    appendChild(c) { this.children.push(c); },
                    addEventListener() {},
                };
            },
        };
        const mockWindow = { addEventListener(event, handler) { listeners[`window_${event}`] = handler; } };
        const sentMessages = [];
        const WebSocketMock = function () {
            return { readyState: 1, send(msg) { sentMessages.push(msg); }, close() {} };
        };
        WebSocketMock.OPEN = 1;
        WebSocketMock.CONNECTING = 0;
        WebSocketMock.CLOSING = 2;
        WebSocketMock.CLOSED = 3;

        const audioContext = makeMockAudioContext();

        const sandbox = {
            window: mockWindow,
            document: mockDocument,
            console: { log() {}, error() {}, warn() {} },
            fetch: async () => ({ status: 200, ok: true, json: async () => ({ ok: true }) }),
            setTimeout(fn, ms) { const entry = { fn, ms }; timers.push(entry); return entry; },
            setInterval() {},
            clearTimeout() {},
            clearInterval() {},
            localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
            URL: global.URL,
            atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
            AudioContext: function () { return audioContext; },
            navigator: { mediaDevices: { getUserMedia: () => Promise.resolve({}) } },
            WebSocket: WebSocketMock,
            performance: { now: () => Date.now() },
            testResults: { listeners, elements, sentMessages, timers, audioContext },
        };

        vm.createContext(sandbox);
        vm.runInContext(cleanText, sandbox);
        return sandbox;
    }

    // Fires the most recently captured setTimeout callback (simulates the
    // fade-out's deferred cleanup completing) without real wall-clock delay.
    function fireLatestTimer(sandbox) {
        const timers = sandbox.testResults.timers;
        const entry = timers[timers.length - 1];
        if (!entry) throw new Error('no timer was scheduled');
        entry.fn();
        return entry.ms;
    }

    // ================= Pure local-VAD algorithm =================

    console.log('Testing local VAD requires multiple consecutive loud frames (not a single spike)...');
    {
        const sandbox = createTestSandbox();
        const state = sandbox.createLocalVadState();
        const opts = { highThreshold: 500, lowThreshold: 250, confirmFrames: 3 };
        // A single loud frame must NOT confirm.
        const r1 = sandbox.evaluateLocalVadFrame(state, 900, opts);
        assert.strictEqual(r1, false, 'one loud frame alone must not confirm a barge-in');
        const r2 = sandbox.evaluateLocalVadFrame(state, 900, opts);
        assert.strictEqual(r2, false, 'two consecutive loud frames must not confirm yet (confirmFrames=3)');
        const r3 = sandbox.evaluateLocalVadFrame(state, 900, opts);
        assert.strictEqual(r3, true, 'the 3rd consecutive loud frame must confirm the barge-in');
    }

    console.log('Testing local VAD hysteresis: re-arms only after dropping below the LOW threshold...');
    {
        const sandbox = createTestSandbox();
        const state = sandbox.createLocalVadState();
        const opts = { highThreshold: 500, lowThreshold: 250, confirmFrames: 3 };
        for (let i = 0; i < 3; i++) sandbox.evaluateLocalVadFrame(state, 900, opts);
        assert.strictEqual(state.armed, false, 'state must be disarmed immediately after confirming once');
        // Staying loud (even fluctuating between high and the dead zone,
        // never below low) must NOT re-confirm -- one client_barge_in per
        // continuous episode.
        const stillLoud = sandbox.evaluateLocalVadFrame(state, 900, opts);
        assert.strictEqual(stillLoud, false, 'must not re-confirm while still loud in the same episode');
        const midZone = sandbox.evaluateLocalVadFrame(state, 300, opts); // between low(250) and high(500)
        assert.strictEqual(midZone, false, 'the hysteresis dead zone must not re-arm or re-confirm');
        assert.strictEqual(state.armed, false, 'dead zone must not re-arm');
        // Drop below LOW -- now re-armed.
        sandbox.evaluateLocalVadFrame(state, 100, opts);
        assert.strictEqual(state.armed, true, 'must re-arm once the level drops below the LOW threshold');
        // New episode: needs confirmFrames again, not just one frame.
        const newEpisodeFirstFrame = sandbox.evaluateLocalVadFrame(state, 900, opts);
        assert.strictEqual(newEpisodeFirstFrame, false, 'a new episode must also require multiple consecutive frames');
    }

    // ================= Hold to Talk: pointerdown fade-out =================

    console.log('Testing Hold to Talk: pointerdown fades out A before any speech recognition, sends session.interrupt immediately...');
    {
        const sandbox = createTestSandbox();
        setLexical(sandbox, 'voiceMode', 'hold_to_talk');
        setLexical(sandbox, 'audioContext', sandbox.testResults.audioContext);
        setLexical(sandbox, 'acceptedPlaybackGenerationId', 'generation_A');
        // Simulate an actively-playing source for A the same way schedulePlayback() would,
        // and a live WebSocket (real dashboard.html's `ws` lexical is only set inside connect()).
        vm.runInContext(`
            const src = testResults.audioContext.createBufferSource();
            src.buffer = testResults.audioContext.createBuffer(1, 100, 16000);
            const gainNode = testResults.audioContext.createGain();
            src.connect(gainNode);
            sourceGainNodes.set(src, gainNode);
            activeSources.add(src);
            testResults.srcA = src;
            testResults.gainA = gainNode;
            ws = { readyState: WebSocket.OPEN, send: (msg) => { testResults.sentMessages.push(msg); } };
        `, sandbox);
        assert.strictEqual(getLexical(sandbox, 'activeSources.size'), 1, 'setup: A must be actively playing before pointerdown');

        // startTurn() is Hold to Talk's pointerdown-triggered function.
        // ensureAudioContextRunning()/ensureMic() below it depend on more
        // mocking than this test needs; we only assert what happens
        // SYNCHRONOUSLY before any of those awaits -- exactly the part the
        // "before any speech recognition" requirement is about.
        const startTurnPromise = sandbox.startTurn();

        // Synchronous-portion assertions (fade started immediately, cancel sent immediately):
        assert.strictEqual(getLexical(sandbox, 'acceptedPlaybackGenerationId'), null, 'acceptedPlaybackGenerationId must be cleared synchronously on pointerdown, before any await');
        assert.strictEqual(getLexical(sandbox, 'cancelledGenerationIds.has("generation_A")'), true, 'A must be marked cancelled synchronously');
        const sentTypes = sandbox.testResults.sentMessages.map((m) => JSON.parse(m).type);
        assert.ok(sentTypes.includes('session.interrupt'), 'session.interrupt must be sent immediately on pointerdown, not deferred behind mic/AudioContext setup');
        // The source itself must still exist at this instant (fading, not yet hard-stopped) --
        // proves this is a fade, not an instant destructive cut.
        assert.strictEqual(sandbox.testResults.srcA.stopped, false, 'source must not be hard-stopped synchronously -- it fades first');
        const gainSchedule = sandbox.testResults.gainA.scheduled.map((e) => e[0]);
        assert.ok(gainSchedule.includes('linearRampToValueAtTime'), 'gain must be ramped down (fade), not silenced with a hard cut');

        // Let the (mocked, never-resolving-mic) startTurn promise settle on
        // its own time; not awaited here since ensureMic()'s mock hangs by
        // design in this sandbox and is out of scope for this test.
        startTurnPromise.catch(() => {});
    }

    // ================= Free Conversation: confirmed local VAD =================

    console.log('Testing Free Conversation: confirmed local VAD stops A before first chunk of B, sends session.interrupt...');
    {
        const sandbox = createTestSandbox();
        setLexical(sandbox, 'voiceMode', 'tap_to_start');
        setLexical(sandbox, 'tapToStartActive', true);
        setLexical(sandbox, 'audioContext', sandbox.testResults.audioContext);
        setLexical(sandbox, 'acceptedPlaybackGenerationId', 'generation_A');
        vm.runInContext(`
            const src = testResults.audioContext.createBufferSource();
            src.buffer = testResults.audioContext.createBuffer(1, 100, 16000);
            const gainNode = testResults.audioContext.createGain();
            src.connect(gainNode);
            sourceGainNodes.set(src, gainNode);
            activeSources.add(src);
            testResults.srcA = src;
            ws = { readyState: WebSocket.OPEN, send: (msg) => { testResults.sentMessages.push(msg); } };
        `, sandbox);
        assert.strictEqual(getLexical(sandbox, 'DeviceVisual.getState()') !== 'speaking', true, 'sanity: DeviceVisual defaults are not speaking yet');
        vm.runInContext("DeviceVisual.setState('speaking');", sandbox);

        sandbox.triggerLocalBargeIn(900);

        assert.strictEqual(getLexical(sandbox, 'acceptedPlaybackGenerationId'), null, 'local VAD confirmation must clear acceptance for A immediately');
        assert.strictEqual(getLexical(sandbox, 'cancelledGenerationIds.has("generation_A")'), true, 'A must be cancelled immediately on confirmed local VAD');
        const sentTypes = sandbox.testResults.sentMessages.map((m) => JSON.parse(m).type);
        assert.ok(sentTypes.includes('session.interrupt'), 'confirmed local VAD must send session.interrupt to the server immediately');

        // Now B's audio.start arrives -- must be accepted (A is gone, not
        // superseding B), and A's fade-out completing afterward must not
        // touch B.
        sandbox.handleEvent({ type: 'audio.start', generation_id: 'generation_B', turn_id: 'turn_B' });
        assert.strictEqual(getLexical(sandbox, 'acceptedPlaybackGenerationId'), 'generation_B', 'B must become the accepted generation');

        fireLatestTimer(sandbox); // completes A's fade-out
        assert.strictEqual(sandbox.testResults.srcA.stopped, true, 'A must be hard-stopped once its fade-out timer fires');
        assert.strictEqual(getLexical(sandbox, 'acceptedPlaybackGenerationId'), 'generation_B', "A's fade-out completing must not disturb B's acceptance");
    }

    console.log('Testing Free Conversation: assistant generation already complete server-side, but still playing locally -- local VAD still stops it (no server message needed)...');
    {
        const sandbox = createTestSandbox();
        setLexical(sandbox, 'voiceMode', 'tap_to_start');
        setLexical(sandbox, 'tapToStartActive', true);
        setLexical(sandbox, 'audioContext', sandbox.testResults.audioContext);
        setLexical(sandbox, 'acceptedPlaybackGenerationId', 'generation_completed_but_playing');
        vm.runInContext(`
            const src = testResults.audioContext.createBufferSource();
            src.buffer = testResults.audioContext.createBuffer(1, 100, 16000);
            const gainNode = testResults.audioContext.createGain();
            src.connect(gainNode);
            sourceGainNodes.set(src, gainNode);
            activeSources.add(src);
            testResults.srcCompleted = src;
        `, sandbox);
        vm.runInContext("DeviceVisual.setState('speaking');", sandbox);

        // No server message of any kind is simulated -- the point is that
        // the local trigger is fully self-sufficient.
        sandbox.triggerLocalBargeIn(900);

        assert.strictEqual(getLexical(sandbox, 'acceptedPlaybackGenerationId'), null, 'local stop must not depend on any server round-trip');
        fireLatestTimer(sandbox);
        assert.strictEqual(sandbox.testResults.srcCompleted.stopped, true, 'the leftover local source must actually be stopped');
    }

    // ================= Epoch invalidation for pending decode =================

    console.log('Testing pending decode resolving after a stop does not resurrect old audio...');
    {
        const sandbox = createTestSandbox();
        setLexical(sandbox, 'audioContext', sandbox.testResults.audioContext);
        setLexical(sandbox, 'acceptedPlaybackGenerationId', 'generation_A');
        let resolveDecode;
        const decodePromise = new Promise((resolve) => { resolveDecode = resolve; });
        vm.runInContext('testResults.audioContext', sandbox).decodeAudioData = () => decodePromise;

        sandbox.playAudioChunk({
            generation_id: 'generation_A',
            mime_type: 'audio/wav',
            audio_base64: Buffer.from([1, 2, 3, 4]).toString('base64'),
        });
        assert.strictEqual(getLexical(sandbox, 'pendingDecodeCount'), 1, 'decode must be tracked as pending');

        // A stop runs WHILE the decode is still in flight.
        sandbox.stopPlaybackImmediately({ reason: 'test_stop', generationId: 'generation_A' });

        // Now the decode resolves, late.
        resolveDecode({ duration: 0.1 });
        await Promise.resolve();
        await Promise.resolve();

        assert.strictEqual(getLexical(sandbox, 'activeSources.size'), 0, 'a decode that resolves after a stop must never schedule playback');
    }

    // ================= Late interrupt for A must not stop B =================

    console.log('Testing a late response.interrupted for A does not stop already-playing B...');
    {
        const sandbox = createTestSandbox();
        setLexical(sandbox, 'audioContext', sandbox.testResults.audioContext);
        setLexical(sandbox, 'acceptedPlaybackGenerationId', 'generation_B');
        vm.runInContext(`
            const src = testResults.audioContext.createBufferSource();
            src.buffer = testResults.audioContext.createBuffer(1, 100, 16000);
            const gainNode = testResults.audioContext.createGain();
            src.connect(gainNode);
            sourceGainNodes.set(src, gainNode);
            activeSources.add(src);
            testResults.srcB = src;
        `, sandbox);

        sandbox.handleEvent({ type: 'response.interrupted', generation_id: 'generation_A', reason: 'provider_interrupted_fallback' });

        assert.strictEqual(getLexical(sandbox, 'acceptedPlaybackGenerationId'), 'generation_B', 'a stale interrupt for A must not clear B\'s acceptance');
        assert.strictEqual(sandbox.testResults.srcB.stopped, false, "B's already-playing source must not be stopped by a late interrupt for A");
    }

    console.log('Testing a late audio.start for an already-cancelled generation is ignored...');
    {
        const sandbox = createTestSandbox();
        setLexical(sandbox, 'acceptedPlaybackGenerationId', 'generation_B');
        vm.runInContext("cancelledGenerationIds.add('generation_A');", sandbox);

        sandbox.handleEvent({ type: 'audio.start', generation_id: 'generation_A', turn_id: 'turn_A' });

        assert.strictEqual(getLexical(sandbox, 'acceptedPlaybackGenerationId'), 'generation_B', 'a late audio.start for a cancelled generation must not clobber the current acceptance');
    }

    console.log('ALL DASHBOARD BARGE-IN TESTS PASSED!');
    if (require.main === module) {
        process.exit(0);
    }
}

if (require.main === module) {
    run().catch((err) => {
        console.error('Dashboard barge-in tests failed:', err);
        process.exit(1);
    });
}

module.exports = { run };
