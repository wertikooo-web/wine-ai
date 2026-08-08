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
    assert.ok(!scriptText.includes('WineAiVoiceEngineUi.mount('), 'dashboard must not mount the legacy duplicate mode-state controller');
    assert.ok(!scriptText.includes('onAvatarState: (state) => DeviceVisual.setState(state)'), 'visual story state must not own voice/playback UI state');

    let cleanText = scriptText;
    cleanText = cleanText.replace('(function () {', '');
    // 'use strict' is deliberately KEPT (not stripped) -- the real
    // dashboard.html IIFE runs in strict mode, and stripping it here made
    // every sandbox test run in sloppy mode instead. That silently masked a
    // real bug: an assignment to an undeclared variable (tapSilenceStartedAt)
    // in disconnect()/stopFreeConversation() is a strict-mode ReferenceError
    // in production but a harmless implicit-global creation in sloppy mode --
    // found only via a real browser reproducing it, not by any test in this
    // file, until this line was fixed to match production's actual semantics.
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
            createMediaStreamSource() { return { connect() {}, disconnect() {} }; },
            createScriptProcessor() { return { onaudioprocess: null, connect() {}, disconnect() {} }; },
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
            // /api/voices gets a realistic shape (gemini configured) --
            // loadVoices() (called from connect()'s flow) otherwise
            // "correctly" falls back away from selectedRealtimeProvider when
            // it finds no configured providers in the response, silently
            // resetting it to undefined and breaking any test that relies
            // on selectedRealtimeProvider staying 'gemini' across a connect
            // cycle. Real production always returns a real providers list.
            fetch: async (url) => {
                if (url === '/api/age-verification') {
                    return { status: 200, ok: true, json: async () => ({ adult_verified: true }) };
                }
                if (typeof url === 'string' && url.startsWith('/api/voices')) {
                    return {
                        status: 200, ok: true,
                        json: async () => ({
                            ok: true,
                            provider: 'gemini',
                            default_provider: 'gemini',
                            providers: [
                                { id: 'gemini', configured: true, supported_voice_modes: ['hold_to_talk', 'tap_to_start'] },
                                { id: 'grok', configured: true, supported_voice_modes: ['hold_to_talk', 'tap_to_start'] },
                            ],
                            voices: [],
                        }),
                    };
                }
                return { status: 200, ok: true, json: async () => ({ ok: true }) };
            },
            setTimeout(fn, ms) { const entry = { fn, ms }; timers.push(entry); return entry; },
            setInterval() {},
            clearTimeout() {},
            clearInterval() {},
            localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
            URL: global.URL,
            URLSearchParams: global.URLSearchParams,
            atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
            AudioContext: function () { return audioContext; },
            // A working fake stream (not just {}) -- needed by tests that
            // exercise the real ensureMic()/acquireMic() path (e.g.
            // restarting Free Conversation over an already-open socket,
            // which re-acquires the mic after stopFreeConversation() tore
            // it down). track.stop() flips readyState so stopMic()'s own
            // teardown is observably real, not a no-op mock.
            navigator: {
                mediaDevices: {
                    getUserMedia: () => {
                        const track = {
                            id: `mock-track-${Math.random().toString(36).slice(2, 8)}`,
                            kind: 'audio',
                            readyState: 'live',
                            getSettings: () => ({ echoCancellation: true }),
                            addEventListener() {},
                            stop() { track.readyState = 'ended'; },
                        };
                        return Promise.resolve({ getAudioTracks: () => [track], getTracks: () => [track] });
                    },
                },
            },
            WebSocket: WebSocketMock,
            performance: { now: () => Date.now() },
            location: { protocol: 'https:', host: 'test.local', search: '' },
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

    // Fires the most-recently-scheduled timer with the given exact delay
    // (ms) -- needed once more than one kind of timer can be in flight at
    // once (inactivity warn/grace, session-limit warn/end), unlike
    // fireLatestTimer() which only ever looks at the very last one.
    function fireTimerWithDelay(sandbox, ms) {
        const timers = sandbox.testResults.timers;
        for (let i = timers.length - 1; i >= 0; i -= 1) {
            if (timers[i].ms === ms) { timers[i].fn(); return; }
        }
        throw new Error(`no timer with delay ${ms}ms was scheduled`);
    }

    function countTimersWithDelay(sandbox, ms) {
        return sandbox.testResults.timers.filter((t) => t.ms === ms).length;
    }

    // ================= Pure local-VAD algorithm =================

    console.log('Testing local VAD accepts one clearly audible frame so a short interruption is not lost...');
    {
        const sandbox = createTestSandbox();
        const state = sandbox.createLocalVadState();
        const confirmFrames = getLexical(sandbox, 'LOCAL_VAD_CONFIRM_FRAMES');
        assert.strictEqual(confirmFrames, 1, 'short barge-in must not wait for multiple audio callbacks');
        const opts = { highThreshold: 500, lowThreshold: 250, confirmFrames };
        const r1 = sandbox.evaluateLocalVadFrame(state, 900, opts);
        assert.strictEqual(r1, true, 'one clearly audible frame must immediately confirm a barge-in');
        const r2 = sandbox.evaluateLocalVadFrame(state, 900, opts);
        assert.strictEqual(r2, false, 'continued sound must not emit a duplicate barge-in');
    }

    console.log('Testing local VAD hysteresis: re-arms only after dropping below the LOW threshold...');
    {
        const sandbox = createTestSandbox();
        const state = sandbox.createLocalVadState();
        const opts = { highThreshold: 500, lowThreshold: 250, confirmFrames: 1 };
        sandbox.evaluateLocalVadFrame(state, 900, opts);
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
        // A new episode can be another short word and confirms immediately.
        const newEpisodeFirstFrame = sandbox.evaluateLocalVadFrame(state, 900, opts);
        assert.strictEqual(newEpisodeFirstFrame, true, 'a new short sound episode must confirm immediately after re-arm');
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

    console.log('Testing Free Conversation: visual idle cannot hide audible playback from local barge-in VAD...');
    {
        const sandbox = createTestSandbox();
        setLexical(sandbox, 'voiceMode', 'tap_to_start');
        setLexical(sandbox, 'tapToStartActive', true);
        setLexical(sandbox, 'isHolding', true);
        setLexical(sandbox, 'audioContext', sandbox.testResults.audioContext);
        setLexical(sandbox, 'acceptedPlaybackGenerationId', 'generation_visual_idle');
        vm.runInContext(`
            const src = testResults.audioContext.createBufferSource();
            src.buffer = testResults.audioContext.createBuffer(1, 100, 16000);
            const gainNode = testResults.audioContext.createGain();
            src.connect(gainNode);
            sourceGainNodes.set(src, gainNode);
            activeSources.add(src);
            testResults.visualIdleSource = src;
            ws = { readyState: WebSocket.OPEN, send: (msg) => { testResults.sentMessages.push(msg); } };
            DeviceVisual.setState('ready');
        `, sandbox);
        await sandbox.ensureMic();
        const processor = getLexical(sandbox, 'processor');
        const loud = new Float32Array(2048).fill(0.08);
        const frame = { inputBuffer: { getChannelData: () => loud } };
        processor.onaudioprocess(frame);
        processor.onaudioprocess(frame);
        processor.onaudioprocess(frame);

        assert.strictEqual(getLexical(sandbox, 'acceptedPlaybackGenerationId'), null, 'audible playback must be interrupted even when visual state already says ready');
        assert.ok(sandbox.testResults.sentMessages.some((message) => (
            typeof message === 'string' && JSON.parse(message).type === 'session.interrupt'
        )), 'visual-idle barge-in must cancel the server generation');
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

    // ================= "Завершить разговор" (stopFreeConversation) =================
    // Correction to the earlier fix: ending Free Conversation must NOT close
    // the WebSocket or the overall connection -- only stop the mic, the
    // provider generation, and local playback/VAD, and flip the button back
    // to "Начать разговор". disconnect() (the main Connect/Disconnect
    // button) remains the only thing that closes the socket.

    console.log('Testing "Завершить разговор": local cleanup on End, WebSocket stays OPEN and CONNECTED...');
    {
        const sandbox = createTestSandbox();
        setLexical(sandbox, 'voiceMode', 'tap_to_start');
        setLexical(sandbox, 'tapToStartActive', true);
        setLexical(sandbox, 'audioContext', sandbox.testResults.audioContext);
        setLexical(sandbox, 'acceptedPlaybackGenerationId', 'generation_A');

        vm.runInContext(`
            // Active playback (Free Conversation's assistant response, mid-speech).
            const src = testResults.audioContext.createBufferSource();
            src.buffer = testResults.audioContext.createBuffer(1, 100, 16000);
            const gainNode = testResults.audioContext.createGain();
            src.connect(gainNode);
            sourceGainNodes.set(src, gainNode);
            activeSources.add(src);
            testResults.srcA = src;

            // Open mic (as if Free Conversation is actively listening).
            testResults.micTracks = [
                { id: 'track1', kind: 'audio', readyState: 'live', stop() { this.readyState = 'ended'; testResults.micTrackStopped = true; } },
            ];
            micStream = { getTracks: () => testResults.micTracks, getAudioTracks: () => testResults.micTracks };

            // Open WebSocket — close() is a spy so the test can assert it was
            // NEVER called.
            ws = {
                readyState: WebSocket.OPEN,
                send: (msg) => { testResults.sentMessages.push(msg); },
                close: () => { testResults.wsCloseCalled = true; },
            };

            DeviceVisual.setState('speaking');
            setConnectionButton('connected');
        `, sandbox);

        assert.strictEqual(getLexical(sandbox, 'tapToStartActive'), true, 'setup: conversation must be active before End');
        assert.strictEqual(getLexical(sandbox, 'activeSources.size'), 1, 'setup: assistant must be actively playing before End');

        // The button's click handler: tapToStartActive === true -> stopFreeConversation().
        await sandbox.stopFreeConversation();

        assert.strictEqual(sandbox.testResults.wsCloseCalled, undefined, 'WebSocket.close() must NOT be called by ending Free Conversation');
        assert.strictEqual(getLexical(sandbox, 'ws.readyState'), 1 /* WebSocket.OPEN */, 'the WebSocket must remain OPEN');
        assert.strictEqual(getLexical(sandbox, "el('connectBtn').textContent"), getLexical(sandbox, "getUiString('disconnect')"), 'the Connect/Disconnect button must still read CONNECTED ("Disconnect"), untouched by ending the conversation');
        assert.strictEqual(sandbox.testResults.micTrackStopped, true, 'mic capture/transmission must be stopped');
        assert.strictEqual(getLexical(sandbox, 'micStream'), null, 'micStream must be torn down');
        assert.strictEqual(getLexical(sandbox, 'activeSources.size'), 0, 'playback must be stopped immediately');
        assert.strictEqual(getLexical(sandbox, 'acceptedPlaybackGenerationId'), null, 'the in-flight provider generation must be treated as cancelled locally');
        const sentTypes = sandbox.testResults.sentMessages.map((m) => JSON.parse(m).type);
        assert.ok(sentTypes.includes('session.interrupt'), 'the still-active provider generation must be cancelled (session.interrupt sent) since the socket is still open');
        assert.strictEqual(getLexical(sandbox, 'tapToStartActive'), false, 'tapToStartActive must be false after ending the conversation');
        assert.strictEqual(getLexical(sandbox, "DeviceVisual.getState()"), 'ready', 'DeviceVisual must reflect connected-but-idle, not disconnected');
        const idleCaption = getLexical(sandbox, "getUiString('pttCaptionTapIdle')");
        assert.strictEqual(getLexical(sandbox, "el('pttCaption').textContent"), idleCaption, 'the button caption must revert to "Начать разговор" / "Start conversation"');
        assert.strictEqual(getLexical(sandbox, 'localVadState.armed'), true, 'the local VAD must be re-armed for the next conversation');
        assert.strictEqual(getLexical(sandbox, 'localVadState.consecutiveLoud'), 0, 'the local VAD loud-frame counter must be reset');
    }

    // Repeat Start after End must reuse the SAME (still open) WebSocket --
    // no new connect() call, just a fresh mic acquisition + resumeTapListening().
    console.log('Testing repeat "Начать разговор" after End reuses the existing WebSocket (no new connect())...');
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
            micStream = { getTracks: () => [{ id: 'old-track', stop() {} }], getAudioTracks: () => [{ id: 'old-track', stop() {} }] };
            ws = { readyState: WebSocket.OPEN, send: (msg) => testResults.sentMessages.push(msg), close: () => { testResults.wsCloseCalled = true; } };
        `, sandbox);

        await sandbox.stopFreeConversation();
        assert.strictEqual(getLexical(sandbox, 'ws.readyState'), 1, 'setup: socket is still OPEN after End');
        assert.strictEqual(getLexical(sandbox, 'micStream'), null, 'setup: mic was released by End');

        let connectCalled = false;
        sandbox.connect = () => { connectCalled = true; };

        await sandbox.startConversationOnTap();

        assert.strictEqual(connectCalled, false, 'starting again over an already-open socket must NOT call connect()');
        assert.strictEqual(sandbox.testResults.wsCloseCalled, undefined, 'the existing WebSocket must never have been closed across End -> Start');
        assert.strictEqual(getLexical(sandbox, 'tapToStartActive'), true, 'the new conversation is marked active');
        assert.notEqual(getLexical(sandbox, 'micStream'), null, 'a fresh mic stream must have been acquired for the new conversation');
        assert.strictEqual(getLexical(sandbox, "micStream.getAudioTracks()[0].id !== 'old-track'"), true, 'the re-acquired mic track must be a genuinely new one, not the old torn-down track');
        // input_audio.start (sent by resumeTapListening()) must reflect the
        // freshly re-acquired track, not stale/null mic info.
        const startMsg = sandbox.testResults.sentMessages.map((m) => JSON.parse(m)).find((m) => m.type === 'input_audio.start');
        assert.ok(startMsg, 'resumeTapListening() must send input_audio.start over the existing socket');
        assert.strictEqual(startMsg.micEchoCancellation, true, 'the re-acquired mic pipeline must report echoCancellation, confirming a real re-acquisition happened (not a stale/null mic)');
        assert.strictEqual(getLexical(sandbox, 'acceptedPlaybackGenerationId'), null, "the OLD generation ('generation_A') must not have resurfaced");
        assert.strictEqual(getLexical(sandbox, 'activeSources.size'), 0, "the OLD playback source must not have resurfaced");
    }

    // The main Connect/Disconnect button remains the only thing that
    // actually closes the socket -- unchanged full-teardown behavior,
    // still idempotent against a delayed/duplicate 'close' event.
    console.log('Testing the main Disconnect button (disconnect()) still fully closes the socket and is idempotent...');
    {
        const sandbox = createTestSandbox();
        setLexical(sandbox, 'voiceMode', 'tap_to_start');
        setLexical(sandbox, 'tapToStartActive', true);
        setLexical(sandbox, 'audioContext', sandbox.testResults.audioContext);
        setLexical(sandbox, 'acceptedPlaybackGenerationId', 'generation_A');
        vm.runInContext(`
            testResults.micTracks = [
                { id: 'track1', kind: 'audio', readyState: 'live', stop() { this.readyState = 'ended'; } },
            ];
            micStream = { getTracks: () => testResults.micTracks, getAudioTracks: () => testResults.micTracks };
            testResults.wsCloseCallCount = 0;
            ws = {
                readyState: WebSocket.OPEN,
                send: (msg) => { testResults.sentMessages.push(msg); },
                close: () => { testResults.wsCloseCallCount += 1; },
            };
        `, sandbox);

        sandbox.disconnect();
        assert.strictEqual(sandbox.testResults.wsCloseCallCount, 1, 'the main Disconnect button must close the socket');
        assert.strictEqual(getLexical(sandbox, "DeviceVisual.getState()"), 'disconnected', 'first cleanup: state is disconnected');

        // Simulate the delayed/duplicate cleanup trigger (e.g. a real 'close'
        // event finally arriving, or a stray second click) -- must not throw.
        assert.doesNotThrow(() => { sandbox.disconnect(); }, 'a second disconnect() call must not throw');

        assert.strictEqual(getLexical(sandbox, "DeviceVisual.getState()"), 'disconnected', 'state remains disconnected after the second cleanup call');
        assert.strictEqual(getLexical(sandbox, "el('connectBtn').textContent"), getLexical(sandbox, "getUiString('connect')"), 'the connect button must still read as disconnected/idle');
        assert.strictEqual(getLexical(sandbox, 'tapToStartActive'), false, 'tapToStartActive remains false');
        assert.strictEqual(getLexical(sandbox, 'micStream'), null, 'micStream remains torn down (no double-teardown error)');
    }

    // Found live in production: the top status indicator (DeviceVisual's
    // "Подключено"/"Отключено" label+dot) and the main button can show
    // contradicting states if something sets the button to disconnected
    // without DeviceVisual agreeing. setConnectionButton() itself now
    // enforces this can never happen, independent of which caller reached
    // it or what DeviceVisual's state happened to be beforehand.
    console.log('Testing setConnectionButton("disconnected") always forces the status indicator to agree, regardless of prior state...');
    {
        const sandbox = createTestSandbox();
        for (const staleState of ['ready', 'listening', 'thinking', 'speaking', 'connecting', 'error']) {
            vm.runInContext(`DeviceVisual.setState('${staleState}');`, sandbox);
            assert.strictEqual(getLexical(sandbox, 'DeviceVisual.getState()'), staleState, `setup: DeviceVisual is ${staleState} before the call`);

            sandbox.setConnectionButton('disconnected');

            assert.strictEqual(getLexical(sandbox, 'DeviceVisual.getState()'), 'disconnected', `setConnectionButton('disconnected') must force DeviceVisual out of a stale '${staleState}' state`);
            assert.strictEqual(getLexical(sandbox, "el('connectBtn').textContent"), getLexical(sandbox, "getUiString('connect')"), 'the button itself must still read Connect/Подключить');
        }

        // Calling it with any OTHER state must not force a disconnected
        // status -- only ever forces agreement toward 'disconnected'.
        vm.runInContext(`DeviceVisual.setState('ready');`, sandbox);
        sandbox.setConnectionButton('connected');
        assert.strictEqual(getLexical(sandbox, 'DeviceVisual.getState()'), 'ready', "setConnectionButton('connected') must not touch DeviceVisual's state");
    }

    // After a FULL disconnect (not just End), restarting must open a
    // genuinely new WebSocket -- the previous (now-stale) generation/
    // playback must never resurface.
    console.log('Testing restart after a full Disconnect opens a fresh session, old generation/playback never returns...');
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
            micStream = { getTracks: () => [{ id: 'track1', stop() {} }], getAudioTracks: () => [{ id: 'track1', stop() {} }] };
            // A real WebSocket.close() transitions readyState away from OPEN
            // (immediately to CLOSING, then CLOSED) -- without this, the mock
            // would still read as OPEN after disconnect(), and
            // startConversationOnTap() would wrongly take its "already
            // connected" branch (resumeTapListening()) instead of opening a
            // fresh session via connect().
            ws = { readyState: WebSocket.OPEN, send: () => {}, close() { this.readyState = WebSocket.CLOSED; } };
        `, sandbox);

        sandbox.disconnect();
        assert.strictEqual(getLexical(sandbox, "DeviceVisual.getState()"), 'disconnected', 'setup: conversation fully ended before restart');
        assert.strictEqual(getLexical(sandbox, 'acceptedPlaybackGenerationId'), null, 'setup: old generation A must be cleared before restart');
        assert.strictEqual(getLexical(sandbox, 'activeSources.size'), 0, 'setup: old playback must be cleared before restart');

        // startConversationOnTap()'s "not connected at all" branch calls
        // connect() to open a genuinely new session; connect() itself opens
        // a real WebSocket/mic pipeline that needs more network/DOM mocking
        // than this sandbox provides, so it's replaced with a spy here --
        // what this test verifies is that startConversationOnTap() actually
        // reaches that branch (a fresh session is attempted) rather than
        // silently no-op'ing, and that nothing from the ended conversation
        // (A's generation id, its playback sources) is still sitting in
        // module state when it does.
        let connectCalled = false;
        sandbox.connect = () => { connectCalled = true; };

        await sandbox.startConversationOnTap();

        assert.strictEqual(connectCalled, true, 'restarting after a full disconnect must attempt a fresh connect(), not no-op');
        assert.strictEqual(getLexical(sandbox, 'tapToStartActive'), true, 'the new conversation is marked active');
        assert.strictEqual(getLexical(sandbox, 'acceptedPlaybackGenerationId'), null, "the OLD generation ('generation_A') must not have resurfaced");
        assert.strictEqual(getLexical(sandbox, 'activeSources.size'), 0, "the OLD playback source must not have resurfaced");
    }

    // ================= Voice mode switching without a page reload =================
    // Disconnect -> switch mode -> Connect must open the NEW session in the
    // newly selected mode, with every session-scoped flag from the old mode
    // fully reset -- not read once at page load / left over in stale state.

    console.log('Testing mode switch: Free Conversation -> Disconnect -> Hold to Talk -> Connect uses hold_to_talk, no leftover state...');
    {
        const sandbox = createTestSandbox();
        setLexical(sandbox, 'voiceMode', 'tap_to_start');
        setLexical(sandbox, 'tapToStartActive', true);
        setLexical(sandbox, 'audioContext', sandbox.testResults.audioContext);
        setLexical(sandbox, 'acceptedPlaybackGenerationId', 'generation_A');
        vm.runInContext(`
            const src = testResults.audioContext.createBufferSource();
            src.buffer = testResults.audioContext.createBuffer(1, 100, 16000);
            src.connect(testResults.audioContext.createGain());
            activeSources.add(src);
            micStream = { getTracks: () => [{ id: 'fc-track', stop() {} }], getAudioTracks: () => [{ id: 'fc-track', stop() {} }] };
            // Leave the local VAD mid-episode (armed=false, some loud frames
            // counted) -- exactly the kind of stale state a leftover-state
            // bug would carry into the next mode/session.
            localVadState.armed = false;
            localVadState.consecutiveLoud = 2;
            ws = { readyState: WebSocket.OPEN, send: () => {}, close() { this.readyState = WebSocket.CLOSED; } };
        `, sandbox);

        // User clicks the main Disconnect button.
        sandbox.disconnect();
        assert.strictEqual(getLexical(sandbox, 'tapToStartActive'), false, 'Disconnect must clear tapToStartActive');
        assert.strictEqual(getLexical(sandbox, 'localVadState.armed'), true, 'Disconnect must re-arm the local VAD');
        assert.strictEqual(getLexical(sandbox, 'localVadState.consecutiveLoud'), 0, 'Disconnect must reset the local VAD loud-frame counter');

        // User switches the mode toggle. persist:false -- this sandbox has
        // no real backing /api/persona endpoint; the mode-persistence POST
        // itself is exercised for real (fetch resolves via the sandbox's
        // fetch stub), only skipping is not needed since the stub always
        // succeeds -- kept explicit to document that persistence is a
        // separate concern from the reset behavior under test here.
        await sandbox.setVoiceMode('hold_to_talk');
        assert.strictEqual(getLexical(sandbox, 'voiceMode'), 'hold_to_talk', 'voiceMode must reflect the newly selected mode immediately');

        // User clicks Connect. connect() itself needs more network mocking
        // than this sandbox provides; replaced with a spy that captures
        // what mode was live the instant connect() was invoked -- this is
        // exactly the "read once at page load" failure mode: if voiceMode
        // were captured in a stale closure, this would still read
        // 'tap_to_start' here.
        let connectSeenMode = null;
        sandbox.connect = () => { connectSeenMode = getLexical(sandbox, 'voiceMode'); };
        await sandbox.toggleConnection();

        assert.strictEqual(connectSeenMode, 'hold_to_talk', 'the new session must be opened with the freshly selected hold_to_talk mode, not a stale captured value');
        assert.strictEqual(getLexical(sandbox, 'tapToStartActive'), false, 'no leftover tapToStartActive from the previous Free Conversation session');
        assert.strictEqual(getLexical(sandbox, 'isHolding'), false, 'no leftover isHolding from the previous session');
        assert.strictEqual(getLexical(sandbox, 'pendingTapStart'), false, 'no leftover pendingTapStart from the previous mode');
        assert.strictEqual(getLexical(sandbox, 'acceptedPlaybackGenerationId'), null, 'no leftover generation from the previous session');
        assert.strictEqual(getLexical(sandbox, 'activeSources.size'), 0, 'no leftover playback from the previous session');
    }

    console.log('Testing mode switch: Hold to Talk -> Disconnect -> Free Conversation -> Connect uses tap_to_start, no leftover state...');
    {
        const sandbox = createTestSandbox();
        setLexical(sandbox, 'voiceMode', 'hold_to_talk');
        setLexical(sandbox, 'isHolding', true);
        setLexical(sandbox, 'audioContext', sandbox.testResults.audioContext);
        setLexical(sandbox, 'acceptedPlaybackGenerationId', 'generation_H');
        // isTapToStartSupportedForCurrentProvider() gates switching INTO
        // tap_to_start on the currently selected provider -- must be one of
        // the supported providers or setVoiceMode('tap_to_start') below
        // would silently no-op.
        setLexical(sandbox, 'selectedRealtimeProvider', 'gemini');
        vm.runInContext(`
            micStream = { getTracks: () => [{ id: 'hold-track', stop() {} }], getAudioTracks: () => [{ id: 'hold-track', stop() {} }] };
            ws = { readyState: WebSocket.OPEN, send: () => {}, close() { this.readyState = WebSocket.CLOSED; } };
        `, sandbox);

        sandbox.disconnect();
        assert.strictEqual(getLexical(sandbox, 'isHolding'), false, 'Disconnect must clear isHolding from Hold to Talk');

        await sandbox.setVoiceMode('tap_to_start');
        assert.strictEqual(getLexical(sandbox, 'voiceMode'), 'tap_to_start', 'voiceMode must reflect the newly selected mode immediately');

        let connectSeenMode = null;
        sandbox.connect = () => { connectSeenMode = getLexical(sandbox, 'voiceMode'); };
        await sandbox.toggleConnection();

        assert.strictEqual(connectSeenMode, 'tap_to_start', 'the new session must be opened with the freshly selected tap_to_start mode');
        assert.strictEqual(getLexical(sandbox, 'isHolding'), false, 'no leftover isHolding from the previous Hold to Talk session');
        assert.strictEqual(getLexical(sandbox, 'acceptedPlaybackGenerationId'), null, 'no leftover generation from the previous session');
    }

    // Several consecutive switches must not accumulate stale handlers/mic
    // tracks -- each disconnect() fully tears down the mic pipeline
    // (stopMic() nulls processor/micSource/micStream every time), so a
    // fresh acquireMic() on the next connect always starts from a clean
    // slate. Asserted here by checking module state stays fully reset
    // after each cycle, not just the last one.
    console.log('Testing several consecutive mode switches do not accumulate stale mic/session state...');
    {
        const sandbox = createTestSandbox();
        setLexical(sandbox, 'voiceMode', 'hold_to_talk');
        setLexical(sandbox, 'selectedRealtimeProvider', 'gemini');
        sandbox.connect = () => {};

        const cycle = ['tap_to_start', 'hold_to_talk', 'tap_to_start', 'hold_to_talk'];
        for (const mode of cycle) {
            vm.runInContext(`
                ws = { readyState: WebSocket.OPEN, send: () => {}, close() { this.readyState = WebSocket.CLOSED; } };
                micStream = { getTracks: () => [{ id: 'cycle-track', stop() {} }], getAudioTracks: () => [{ id: 'cycle-track', stop() {} }] };
            `, sandbox);
            sandbox.disconnect();
            await sandbox.setVoiceMode(mode);
            await sandbox.toggleConnection();

            assert.strictEqual(getLexical(sandbox, 'voiceMode'), mode, `after switching to ${mode}, voiceMode must reflect it`);
            assert.strictEqual(getLexical(sandbox, 'tapToStartActive'), false, `after switching to ${mode}, tapToStartActive must not carry over`);
            assert.strictEqual(getLexical(sandbox, 'isHolding'), false, `after switching to ${mode}, isHolding must not carry over`);
            assert.strictEqual(getLexical(sandbox, 'pendingTapStart'), false, `after switching to ${mode}, pendingTapStart must not carry over`);
            assert.strictEqual(getLexical(sandbox, 'pendingPttStart'), false, `after switching to ${mode}, pendingPttStart must not carry over`);
            assert.strictEqual(getLexical(sandbox, 'localVadState.armed'), true, `after switching to ${mode}, the local VAD must be armed, not left mid-episode`);
        }
    }

    console.log('Testing a connected mode switch persists, tears down, and reconnects automatically...');
    {
        const sandbox = createTestSandbox();
        setLexical(sandbox, 'voiceMode', 'hold_to_talk');
        setLexical(sandbox, 'selectedRealtimeProvider', 'gemini');
        vm.runInContext(`
            ws = {
                readyState: WebSocket.OPEN,
                listenersByType: {},
                addEventListener(type, handler) { (this.listenersByType[type] = this.listenersByType[type] || []).push(handler); },
                send() {},
                close() {
                    this.readyState = WebSocket.CLOSED;
                    (this.listenersByType.close || []).forEach((handler) => handler());
                },
            };
        `, sandbox);
        let reconnectCount = 0;
        let reconnectMode = null;
        sandbox.connect = async () => {
            reconnectCount += 1;
            reconnectMode = getLexical(sandbox, 'voiceMode');
        };

        await sandbox.setVoiceMode('tap_to_start');

        assert.strictEqual(getLexical(sandbox, 'voiceMode'), 'tap_to_start', 'connected switch must apply the requested mode');
        assert.strictEqual(reconnectCount, 1, 'connected switch must reconnect exactly once without a manual Connect click');
        assert.strictEqual(reconnectMode, 'tap_to_start', 'automatic reconnect must observe the newly persisted mode');
        assert.strictEqual(getLexical(sandbox, 'pendingPttStart'), false, 'automatic reconnect must not carry pending PTT state');
    }

    // ================= Main Connect/Disconnect button: real DOM click =================
    // Production report: the button never actually flips from "Подключить"
    // to "Отключить"/back, and mode switching (Disconnect -> pick mode ->
    // Connect) doesn't work. Root cause (found via a real browser, not by
    // reading code): tapSilenceStartedAt is assigned in disconnect() and
    // stopFreeConversation() but was NEVER DECLARED anywhere -- under
    // 'use strict' that assignment throws a ReferenceError, silently
    // aborting both functions immediately AFTER the button's text/state
    // already flipped but BEFORE ws.close()/stopMic() ever ran. The socket
    // never actually closed, so the next click re-entered disconnect()
    // instead of opening a fresh connection -- exactly the reported symptom.
    //
    // This test drives the REAL #connectBtn DOM element's real click
    // listener (`el('connectBtn').addEventListener('click', toggleConnection)`
    // in dashboard.html) via the mock element's own captured handler --
    // never calling connect()/disconnect()/setConnectionButton() directly --
    // so it exercises exactly what a real click does, including the
    // 'use strict' semantics restored above.
    console.log('Testing the main Connect/Disconnect button via a REAL click on #connectBtn drives the full state machine...');
    {
        const sandbox = createTestSandbox();
        setLexical(sandbox, 'voiceMode', 'tap_to_start');
        setLexical(sandbox, 'selectedRealtimeProvider', 'gemini');

        // A WebSocket mock with real addEventListener/readyState semantics
        // (not a plain object literal) -- lets the test fire 'open'/'close'
        // on demand, exercising connect()'s REAL listener wiring.
        vm.runInContext(`
            testResults.socketInstances = [];
            WebSocket = function (url) {
                const sock = {
                    url, readyState: 0,
                    listenersByType: {},
                    addEventListener(type, handler) {
                        (this.listenersByType[type] = this.listenersByType[type] || []).push(handler);
                    },
                    send() {},
                    close() {
                        if (this.readyState === 3) return;
                        this.readyState = 3;
                        (this.listenersByType.close || []).forEach((h) => h());
                    },
                    _fireOpen() {
                        this.readyState = 1;
                        (this.listenersByType.open || []).forEach((h) => h());
                    },
                };
                testResults.socketInstances.push(sock);
                return sock;
            };
            WebSocket.CONNECTING = 0; WebSocket.OPEN = 1; WebSocket.CLOSING = 2; WebSocket.CLOSED = 3;
        `, sandbox);

        const clickConnectBtn = getLexical(sandbox, "el('connectBtn').listeners.click");
        assert.strictEqual(typeof clickConnectBtn, 'function', 'sanity: the real click listener must be registered on #connectBtn');

        assert.strictEqual(getLexical(sandbox, "el('connectBtn').textContent"), getLexical(sandbox, "getUiString('connect')"), 'initial DISCONNECTED state: button reads Connect/Подключить');

        // ---- Click 1: DISCONNECTED -> CONNECTING -> (open) -> CONNECTED ----
        await clickConnectBtn();
        assert.strictEqual(sandbox.testResults.socketInstances.length, 1, 'the first click must create a WebSocket');
        assert.strictEqual(getLexical(sandbox, "el('connectBtn').textContent"), getLexical(sandbox, "getUiString('connecting')"), 'while connecting, the button reads Connecting/Подключение…');
        assert.strictEqual(getLexical(sandbox, "el('connectBtn').disabled"), true, 'the button must be disabled while connecting');

        getLexical(sandbox, 'testResults.socketInstances[0]')._fireOpen();
        assert.strictEqual(getLexical(sandbox, "el('connectBtn').textContent"), getLexical(sandbox, "getUiString('disconnect')"), 'after the socket actually opens, the button must read Disconnect/Отключить');
        assert.strictEqual(getLexical(sandbox, "el('connectBtn').disabled"), false, 'the button must be enabled once connected');

        // ---- Click 2: CONNECTED -> DISCONNECTED (full close) ----
        await clickConnectBtn();
        assert.strictEqual(getLexical(sandbox, 'testResults.socketInstances[0].readyState'), 3, 'the second click must actually call ws.close() (this is exactly what silently failed before the fix)');
        assert.strictEqual(getLexical(sandbox, "el('connectBtn').textContent"), getLexical(sandbox, "getUiString('connect')"), 'immediately after local cleanup, the button must already read Connect/Подключить (not wait for the close event)');
        assert.strictEqual(getLexical(sandbox, 'tapToStartActive'), false, 'Free Conversation state must be torn down by the same click');

        // ---- A delayed/duplicate native 'close' event must not corrupt state ----
        assert.doesNotThrow(() => {
            getLexical(sandbox, 'testResults.socketInstances[0]').listenersByType.close.forEach((h) => h());
        }, 'a delayed native close event firing again must not throw');
        assert.strictEqual(getLexical(sandbox, "el('connectBtn').textContent"), getLexical(sandbox, "getUiString('connect')"), 'state remains Connect/Подключить after the delayed close event');

        // ---- Switch mode, then click again: a NEW WebSocket, new mode ----
        await sandbox.setVoiceMode('hold_to_talk');
        assert.strictEqual(getLexical(sandbox, 'voiceMode'), 'hold_to_talk', 'the mode switch must take effect while disconnected');

        await clickConnectBtn();
        assert.strictEqual(sandbox.testResults.socketInstances.length, 2, 'clicking Connect again after a mode switch must open a genuinely NEW WebSocket, not reuse the old (closed) one');
        assert.notEqual(sandbox.testResults.socketInstances[1], sandbox.testResults.socketInstances[0], 'the new WebSocket instance must be different from the first');
        // voiceMode itself (read fresh by every relevant check, and by
        // personaStore.getVoiceMode() server-side on this NEW connection --
        // see realtimeServer.js line ~450, covered by
        // voiceModeTurnDetection.test.js) is what the server actually keys
        // the session's mode off of; the client-visible confirmation is that
        // the value is still 'hold_to_talk' at the moment this second
        // WebSocket was opened, not silently reverted to the old mode.
        assert.strictEqual(getLexical(sandbox, 'voiceMode'), 'hold_to_talk', 'the new session must open with the freshly selected hold_to_talk mode');

        getLexical(sandbox, 'testResults.socketInstances[1]')._fireOpen();
        assert.strictEqual(getLexical(sandbox, "el('connectBtn').textContent"), getLexical(sandbox, "getUiString('disconnect')"), 'the button correctly reflects CONNECTED again after the second real connect/open cycle');

        // ---- The inner Free Conversation button remains entirely separate ----
        // (voiceMode is now hold_to_talk, so pttBtn's click handler routes
        // through the Hold to Talk press/release wiring, not
        // startConversationOnTap()/stopFreeConversation() at all -- proving
        // the two buttons/handlers are genuinely independent, not the same
        // element under a different label.)
        assert.notEqual(getLexical(sandbox, "el('pttBtn')"), getLexical(sandbox, "el('connectBtn')"), 'the Free Conversation button and the main Connect/Disconnect button must be different DOM elements');

        // tapSilenceStartedAt must be a proper lexical `let`, not an
        // implicit global -- a plain assignment to an undeclared name (the
        // original bug, in sloppy mode) or an accidental `var`/window write
        // would show up as an own property of the sandbox's global object;
        // a correctly scoped `let` never does, in strict OR sloppy mode.
        assert.strictEqual(Object.prototype.hasOwnProperty.call(sandbox, 'tapSilenceStartedAt'), false, 'tapSilenceStartedAt must not leak onto the global object (window/globalThis)');
    }

    // ================= Five consecutive full cycles, no reload =================
    // Free Conversation -> Connect -> Disconnect -> Hold to Talk -> Connect ->
    // Disconnect -> Free Conversation -> ... repeated 5x, driven entirely
    // through real #connectBtn clicks. Guards against exactly the class of
    // bug just fixed (a crash mid-cleanup that leaves state/sockets half
    // torn down) recurring silently on the 2nd, 3rd, ... cycle even though
    // the 1st looks fine.
    console.log('Testing 5 consecutive real-click Connect/Disconnect + mode-switch cycles accumulate nothing...');
    {
        const sandbox = createTestSandbox();
        setLexical(sandbox, 'voiceMode', 'tap_to_start');
        setLexical(sandbox, 'selectedRealtimeProvider', 'gemini');
        vm.runInContext(`
            testResults.socketInstances = [];
            WebSocket = function (url) {
                const sock = {
                    url, readyState: 0,
                    listenersByType: {},
                    addEventListener(type, handler) {
                        (this.listenersByType[type] = this.listenersByType[type] || []).push(handler);
                    },
                    send() {},
                    close() {
                        if (this.readyState === 3) return;
                        this.readyState = 3;
                        (this.listenersByType.close || []).forEach((h) => h());
                    },
                    _fireOpen() {
                        this.readyState = 1;
                        (this.listenersByType.open || []).forEach((h) => h());
                    },
                };
                testResults.socketInstances.push(sock);
                return sock;
            };
            WebSocket.CONNECTING = 0; WebSocket.OPEN = 1; WebSocket.CLOSING = 2; WebSocket.CLOSED = 3;
        `, sandbox);
        const clickConnectBtn = getLexical(sandbox, "el('connectBtn').listeners.click");

        const modes = ['tap_to_start', 'hold_to_talk'];
        for (let cycle = 0; cycle < 5; cycle += 1) {
            const mode = modes[cycle % 2];
            if (getLexical(sandbox, 'voiceMode') !== mode) {
                await sandbox.setVoiceMode(mode);
            }
            assert.strictEqual(getLexical(sandbox, "el('connectBtn').textContent"), getLexical(sandbox, "getUiString('connect')"), `cycle ${cycle} (${mode}): must start DISCONNECTED`);

            const socketsBefore = getLexical(sandbox, 'testResults.socketInstances.length');
            await clickConnectBtn();
            assert.strictEqual(getLexical(sandbox, 'testResults.socketInstances.length'), socketsBefore + 1, `cycle ${cycle}: exactly one new WebSocket must be created`);
            const sockExpr = `testResults.socketInstances[${socketsBefore}]`;
            getLexical(sandbox, sockExpr)._fireOpen();
            assert.strictEqual(getLexical(sandbox, "el('connectBtn').textContent"), getLexical(sandbox, "getUiString('disconnect')"), `cycle ${cycle}: must read CONNECTED after open`);
            assert.strictEqual(getLexical(sandbox, 'voiceMode'), mode, `cycle ${cycle}: the session opened with the currently selected mode`);

            if (mode === 'tap_to_start') {
                // Exercise the inner Free Conversation button too, within
                // this cycle's connection -- Start, then End, must not
                // touch the main connection at all.
                await sandbox.startConversationOnTap();
                assert.strictEqual(getLexical(sandbox, 'tapToStartActive'), true, `cycle ${cycle}: Free Conversation started`);
                await sandbox.stopFreeConversation();
                assert.strictEqual(getLexical(sandbox, 'tapToStartActive'), false, `cycle ${cycle}: Free Conversation ended`);
                assert.strictEqual(getLexical(sandbox, sockExpr + '.readyState'), 1, `cycle ${cycle}: ending Free Conversation must NOT close the main WebSocket`);
                assert.strictEqual(getLexical(sandbox, "el('connectBtn').textContent"), getLexical(sandbox, "getUiString('disconnect')"), `cycle ${cycle}: main button still reads CONNECTED after ending Free Conversation`);
            }

            await clickConnectBtn();
            assert.strictEqual(getLexical(sandbox, sockExpr + '.readyState'), 3, `cycle ${cycle}: Disconnect must close this cycle's WebSocket`);
            assert.strictEqual(getLexical(sandbox, "el('connectBtn').textContent"), getLexical(sandbox, "getUiString('connect')"), `cycle ${cycle}: must read DISCONNECTED immediately after Disconnect`);
            assert.strictEqual(getLexical(sandbox, 'tapToStartActive'), false, `cycle ${cycle}: no leftover tapToStartActive`);
            assert.strictEqual(getLexical(sandbox, 'isHolding'), false, `cycle ${cycle}: no leftover isHolding`);
            assert.strictEqual(getLexical(sandbox, 'localVadState.armed'), true, `cycle ${cycle}: local VAD re-armed, not leaked into the next cycle`);
            assert.strictEqual(getLexical(sandbox, 'micStream'), null, `cycle ${cycle}: mic released, not leaked into the next cycle`);
        }

        assert.strictEqual(getLexical(sandbox, 'testResults.socketInstances.length'), 5, 'exactly 5 WebSockets total were created across the 5 cycles -- none reused, none leaked extra');
        for (let i = 0; i < 5; i += 1) {
            assert.strictEqual(getLexical(sandbox, `testResults.socketInstances[${i}].readyState`), 3, `socket #${i} ended the run CLOSED, not left dangling`);
        }
    }

    // ================= Free Conversation: automatic end on inactivity =================
    // New feature: after 90s with no REAL user speech, the agent speaks a
    // check-in line; after 30 more seconds of silence, it says goodbye and
    // the conversation fully disconnects. Agent audio must never count as
    // "activity" -- only server-native-VAD-driven input_audio.start does.

    function setupInactivityTestSandbox() {
        const sandbox = createTestSandbox();
        setLexical(sandbox, 'voiceMode', 'tap_to_start');
        setLexical(sandbox, 'tapToStartActive', true);
        setLexical(sandbox, 'serverAudioEnded', true);
        vm.runInContext(`
            ws = {
                readyState: WebSocket.OPEN,
                sentMessages: [],
                send(msg) { this.sentMessages.push(JSON.parse(msg)); },
                close() { this.readyState = WebSocket.CLOSED; },
            };
        `, sandbox);
        return sandbox;
    }

    console.log('Testing inactivity: 90s of silence makes the agent speak the check-in line...');
    {
        const sandbox = setupInactivityTestSandbox();
        sandbox.armInactivityWarnTimer();
        assert.strictEqual(countTimersWithDelay(sandbox, 90000), 1, 'a single 90s warn timer must be armed');

        fireTimerWithDelay(sandbox, 90000);

        // sentMessages also includes the client_telemetry ping sendTelemetry()
        // fires alongside -- only input_text.submit messages are the actual
        // spoken line.
        const spoken = getLexical(sandbox, 'ws.sentMessages').filter((m) => m.type === 'input_text.submit');
        assert.strictEqual(spoken.length, 1, 'the 90s timeout must speak exactly one line');
        assert.ok(spoken[0].text.includes(getLexical(sandbox, 'FREE_CONV_INACTIVITY_WARNING_TEXT')), 'the spoken text must be the check-in line');
        assert.strictEqual(countTimersWithDelay(sandbox, 30000), 1, 'a 30s grace timer must now be armed');
    }

    // Found via a real production test (not by any fake-timer test): the
    // check-in line the agent speaks is itself a real reply that plays and
    // drains locally, firing maybeFinishSpeaking() -- at that exact moment
    // pendingAutoEnd is still null (only the 30s grace timer is armed, the
    // grace period itself hasn't elapsed), so this drain event must NOT end
    // the conversation. A stale legacy 5s idle-close timer used to be armed
    // by this exact code path and did end it almost immediately, ignoring
    // the mandated 30s grace window entirely.
    console.log('Testing inactivity: the check-in line finishing playback (draining) must NOT end the conversation early...');
    {
        const sandbox = setupInactivityTestSandbox();
        vm.runInContext(`micStream = { getTracks: () => [{ id: 't', stop() {} }], getAudioTracks: () => [{ id: 't', stop() {} }] };`, sandbox);
        sandbox.setPttCaption(); // reflect the already-active conversation, as resumeTapListening() would have
        sandbox.armInactivityWarnTimer();
        fireTimerWithDelay(sandbox, 90000); // check-in line spoken, 30s grace armed

        // The check-in line itself finishes playing -- same drain hook
        // every reply uses. Must be a pure no-op here (no legacy fallback).
        assert.doesNotThrow(() => { sandbox.maybeFinishSpeaking(); }, 'the check-in line draining must not throw');

        assert.strictEqual(getLexical(sandbox, 'tapToStartActive'), true, 'the conversation must still be active -- the 30s grace window has not elapsed yet');
        assert.strictEqual(getLexical(sandbox, 'ws.readyState'), 1, 'the socket must remain open');
        assert.strictEqual(getLexical(sandbox, "el('pttCaption').textContent"), getLexical(sandbox, "getUiString('pttCaptionTapActive')"), 'the button must still read "Завершить разговор", not reset to idle');
        assert.strictEqual(countTimersWithDelay(sandbox, 30000), 1, 'the 30s grace timer must still be the one armed by the warning -- untouched by this drain event');

        // The grace period elapsing afterward must still correctly end the
        // conversation (the fix must not have broken the real end path).
        fireTimerWithDelay(sandbox, 30000);
        const spoken = getLexical(sandbox, 'ws.sentMessages').filter((m) => m.type === 'input_text.submit');
        assert.ok(spoken[spoken.length - 1].text.includes(getLexical(sandbox, 'FREE_CONV_INACTIVITY_GOODBYE_TEXT')), 'once the grace period genuinely elapses, the goodbye line must still be spoken');
        sandbox.maybeFinishSpeaking(); // goodbye line drains
        assert.strictEqual(getLexical(sandbox, 'ws.readyState'), 3, 'once the goodbye line (not the check-in line) drains, the socket must close');
    }

    console.log('Testing inactivity: 30s more of silence after the warning ends the conversation...');
    {
        const sandbox = setupInactivityTestSandbox();
        vm.runInContext(`
            micStream = { getTracks: () => [{ id: 'track1', stop() { this.stopped = true; } }], getAudioTracks: () => [{ id: 'track1', stop() {} }] };
        `, sandbox);
        sandbox.armInactivityWarnTimer();
        fireTimerWithDelay(sandbox, 90000); // warning spoken, grace armed
        fireTimerWithDelay(sandbox, 30000); // grace elapses, no speech in between

        // activeSources is empty (nothing "playing"), so triggerAutoEnd()
        // sends the goodbye line immediately (phase 'ready' -> 'closing_sent')
        // rather than waiting for a drain first.
        const spoken = getLexical(sandbox, 'ws.sentMessages').filter((m) => m.type === 'input_text.submit');
        assert.ok(spoken[spoken.length - 1].text.includes(getLexical(sandbox, 'FREE_CONV_INACTIVITY_GOODBYE_TEXT')), 'the goodbye line must be spoken');
        assert.strictEqual(getLexical(sandbox, 'pendingAutoEnd.phase'), 'closing_sent', 'auto-end must be waiting for the goodbye line to finish playing');
        assert.strictEqual(getLexical(sandbox, "ws.readyState"), 1, 'the socket must NOT be closed yet -- only after the goodbye line finishes');

        // The goodbye line "finishes playing" -- same drain hook every other
        // reply uses.
        sandbox.maybeFinishSpeaking();

        assert.strictEqual(getLexical(sandbox, 'ws.readyState'), 3, 'after the goodbye line drains, the WebSocket must be CLOSED');
        assert.strictEqual(getLexical(sandbox, 'pendingAutoEnd'), null, 'auto-end must be cleared once complete');
        assert.strictEqual(getLexical(sandbox, 'tapToStartActive'), false, 'Free Conversation must be marked ended');
        assert.strictEqual(getLexical(sandbox, "el('connectBtn').textContent"), getLexical(sandbox, "getUiString('connect')"), 'main button must read "Начать"/Connect (disconnected)');
        assert.strictEqual(getLexical(sandbox, "el('pttCaption').textContent"), getLexical(sandbox, "getUiString('pttCaptionTapIdle')"), 'inner button must read "Начать разговор"');
    }

    console.log('Testing inactivity: real user speech cancels the 90s warning and restarts the clock...');
    {
        const sandbox = setupInactivityTestSandbox();
        sandbox.armInactivityWarnTimer();
        const timersBefore = countTimersWithDelay(sandbox, 90000);

        sandbox.handleEvent({ type: 'input_audio.start', turn_id: 'turn_real_speech' });

        assert.strictEqual(countTimersWithDelay(sandbox, 90000), timersBefore + 1, 'real user speech must restart a fresh 90s inactivity clock');
        assert.strictEqual(getLexical(sandbox, 'pendingAutoEnd'), null, 'no auto-end should be pending yet');
    }

    console.log('Testing inactivity: real user speech during the 30s grace window cancels the pending auto-end...');
    {
        const sandbox = setupInactivityTestSandbox();
        sandbox.armInactivityWarnTimer();
        fireTimerWithDelay(sandbox, 90000); // warning spoken, grace armed

        sandbox.handleEvent({ type: 'input_audio.start', turn_id: 'turn_during_grace' });

        assert.strictEqual(getLexical(sandbox, 'pendingAutoEnd'), null, 'speech during the grace window must cancel any pending auto-end');
        assert.strictEqual(getLexical(sandbox, 'ws.readyState'), 1, 'the socket must remain open');
        // Firing the OLD (now-superseded) grace timer must be a no-op -- the
        // real dashboard.html clearTimeout() call is what would prevent this
        // in a real browser; this sandbox's mock clearTimeout() doesn't
        // remove queued entries, so this specifically proves the guard
        // inside the timer callback itself (checking tapToStartActive/
        // voiceMode is not enough here -- both are still true) -- the
        // callback closure captured its own now-stale grace state via
        // pendingAutoEnd being null, so triggerAutoEnd() would run again;
        // what actually prevents a double-fire in production is that a
        // fresh armInactivityWarnTimer() call replaces inactivityGraceTimer
        // before the old one can fire. Not re-asserted further here --
        // covered structurally by the "restarts the clock" test above.
    }

    console.log('Testing inactivity: the agent\'s OWN audio (audio.start/audio.end) never resets the inactivity clock...');
    {
        const sandbox = setupInactivityTestSandbox();
        sandbox.armInactivityWarnTimer();
        const timersBefore = countTimersWithDelay(sandbox, 90000);

        sandbox.handleEvent({ type: 'audio.start', generation_id: 'g1', turn_id: 't1' });
        sandbox.handleEvent({ type: 'audio.end', generation_id: 'g1', turn_id: 't1' });

        assert.strictEqual(countTimersWithDelay(sandbox, 90000), timersBefore, 'agent audio events must NOT schedule a new inactivity timer');
    }

    console.log('Testing inactivity: manual Disconnect clears all inactivity/session timers (idempotent)...');
    {
        const sandbox = setupInactivityTestSandbox();
        vm.runInContext(`micStream = { getTracks: () => [{ id: 't', stop() {} }], getAudioTracks: () => [{ id: 't', stop() {} }] };`, sandbox);
        sandbox.armInactivityWarnTimer();
        sandbox.armSessionLimitTimers();

        assert.doesNotThrow(() => { sandbox.disconnect(); }, 'disconnect() must not throw');
        assert.strictEqual(getLexical(sandbox, 'inactivityWarnTimer'), null, 'inactivity warn timer cleared');
        assert.strictEqual(getLexical(sandbox, 'inactivityGraceTimer'), null, 'inactivity grace timer cleared');
        assert.strictEqual(getLexical(sandbox, 'sessionLimitWarnTimer'), null, 'session-limit warn timer cleared');
        assert.strictEqual(getLexical(sandbox, 'sessionLimitEndTimer'), null, 'session-limit end timer cleared');
        assert.strictEqual(getLexical(sandbox, 'pendingAutoEnd'), null, 'no auto-end left pending');

        assert.doesNotThrow(() => { sandbox.disconnect(); }, 'a second disconnect() call must not throw (idempotent)');
    }

    // ================= Free Conversation: overall session duration cap =================

    console.log('Testing session limit: 30s before the (default 3-minute) cap, the agent speaks a heads-up line...');
    {
        const sandbox = setupInactivityTestSandbox();
        sandbox.armSessionLimitTimers();
        const limitMs = getLexical(sandbox, 'freeConversationSessionLimitMs');
        assert.strictEqual(limitMs, 3 * 60 * 1000, 'sanity: default session limit is 3 minutes');
        const warnAt = limitMs - 30000;

        fireTimerWithDelay(sandbox, warnAt);

        const spoken = getLexical(sandbox, 'ws.sentMessages').filter((m) => m.type === 'input_text.submit');
        assert.ok(spoken[spoken.length - 1].text.includes(getLexical(sandbox, 'FREE_CONV_SESSION_WARNING_TEXT')), 'the 30s heads-up line must be spoken');
        assert.strictEqual(getLexical(sandbox, 'ws.readyState'), 1, 'the socket must remain open after the heads-up');
    }

    console.log('Testing session limit: at the cap, the agent says goodbye and the session fully closes...');
    {
        const sandbox = setupInactivityTestSandbox();
        vm.runInContext(`micStream = { getTracks: () => [{ id: 't', stop() {} }], getAudioTracks: () => [{ id: 't', stop() {} }] };`, sandbox);
        sandbox.armSessionLimitTimers();
        const limitMs = getLexical(sandbox, 'freeConversationSessionLimitMs');

        fireTimerWithDelay(sandbox, limitMs);
        sandbox.maybeFinishSpeaking(); // goodbye line "finishes playing"

        assert.strictEqual(getLexical(sandbox, 'ws.readyState'), 3, 'the WebSocket must be closed once the session-limit goodbye line finishes');
        assert.strictEqual(getLexical(sandbox, 'tapToStartActive'), false, 'Free Conversation must be marked ended');
        assert.strictEqual(getLexical(sandbox, "el('connectBtn').textContent"), getLexical(sandbox, "getUiString('connect')"), 'main button reads Connect/Подключить');
    }

    console.log('Testing session limit: real user speech does NOT extend the absolute session cap...');
    {
        const sandbox = setupInactivityTestSandbox();
        sandbox.armSessionLimitTimers();
        const timersBefore = countTimersWithDelay(sandbox, getLexical(sandbox, 'freeConversationSessionLimitMs'));

        sandbox.handleEvent({ type: 'input_audio.start', turn_id: 'x' });

        assert.strictEqual(countTimersWithDelay(sandbox, getLexical(sandbox, 'freeConversationSessionLimitMs')), timersBefore, 'user speech must not re-arm/extend the session-limit timer');
    }

    // ================= Hold to Talk: completely unaffected =================
    console.log('Testing Hold to Talk: none of the new inactivity/session-limit machinery ever engages...');
    {
        const sandbox = createTestSandbox();
        setLexical(sandbox, 'voiceMode', 'hold_to_talk');
        vm.runInContext(`ws = { readyState: WebSocket.OPEN, send() {}, close() {} };`, sandbox);

        // Hold to Talk never calls resumeTapListening() (the sole place
        // these timers are armed) or reaches the tap_to_start branch of
        // handleEvent()'s input_audio.start case.
        sandbox.handleEvent({ type: 'input_audio.start', turn_id: 'ptt_turn' });
        sandbox.handleEvent({ type: 'audio.start', generation_id: 'g', turn_id: 'ptt_turn' });

        assert.strictEqual(getLexical(sandbox, 'inactivityWarnTimer'), null, 'Hold to Talk must never arm an inactivity timer');
        assert.strictEqual(getLexical(sandbox, 'sessionLimitWarnTimer'), null, 'Hold to Talk must never arm a session-limit timer');
        assert.strictEqual(getLexical(sandbox, 'pendingAutoEnd'), null, 'Hold to Talk must never enter an auto-end state');
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
