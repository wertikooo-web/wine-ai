'use strict';

// Narrow regression coverage for two dashboard.html UI bugs:
//
// 1. disconnect() used to call DeviceVisual.setState('ready') (the
//    "Connected" state) instead of 'disconnected', and relied solely on the
//    WebSocket 'close' event to ever correct the status dot/text and the
//    Connect/Disconnect button label. If that event was delayed or never
//    fired, the UI stayed stuck showing "Connected" with a "Disconnect"
//    button after the user had actually disconnected.
//
// 2. setVoiceMode() persisted the new mode to the server via an unawaited
//    fetch('/api/persona') -- nothing stopped the user from reconnecting
//    before that POST resolved, so a fast Disconnect -> switch mode ->
//    Connect could open a new session while the server still had the OLD
//    persisted voiceMode, silently applying the wrong mode until a full
//    page reload. It also allowed switching mode while a session was live.
//
// Uses the same sandbox-via-vm pattern as dashboardVoiceConfiguration.test.js
// (extract dashboard.html's inline <script>, run it in a vm context with a
// minimal mock DOM/fetch/WebSocket) so real dashboard.html code is exercised,
// not a reimplementation of it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function run() {
    console.log('Running Dashboard Connection Status & Voice Mode UI Tests...');

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

    assert.ok(htmlContent.includes('id="voiceModeError"'), 'HTML must contain #voiceModeError');

    function setLexical(sandbox, varName, value) {
        sandbox._tmpVal = value;
        vm.runInContext(`${varName} = _tmpVal; delete _tmpVal;`, sandbox);
    }

    // const/let bindings (DeviceVisual, voiceMode, ...) are block-scoped to
    // the script and never become properties of the vm context object --
    // only `function` declarations do (that's why sandbox.setVoiceMode()
    // etc. work directly). Reading them back requires evaluating an
    // expression inside the same context, not a property access.
    function getLexical(sandbox, expr) {
        return vm.runInContext(expr, sandbox);
    }

    function createTestSandbox(mockFetchImpl = null) {
        const listeners = {};
        const elements = {};

        function getMockElement(id) {
            if (!elements[id]) {
                elements[id] = {
                    id,
                    value: '',
                    textContent: '',
                    innerHTML: '',
                    disabled: false,
                    hidden: false,
                    style: {},
                    dataset: {},
                    className: '',
                    classList: {
                        add() {},
                        remove() {},
                        toggle() {},
                    },
                    children: [],
                    listeners: {},
                    addEventListener(event, handler) {
                        this.listeners[event] = handler;
                        listeners[`${id}_${event}`] = handler;
                    },
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
            querySelector(selector) {
                if (selector.startsWith('#')) return getMockElement(selector.slice(1));
                return null;
            },
            querySelectorAll() { return []; },
            createElement(tagName) {
                return {
                    tagName: tagName.toUpperCase(),
                    children: [],
                    textContent: '',
                    style: {},
                    className: '',
                    append(...nodes) { this.children.push(...nodes); },
                    appendChild(c) { this.children.push(c); },
                    addEventListener(event, handler) {
                        if (!this.listeners) this.listeners = {};
                        this.listeners[event] = handler;
                    },
                };
            },
        };

        const mockWindow = { addEventListener(event, handler) { listeners[`window_${event}`] = handler; } };

        const fetchCalls = [];
        const mockFetch = async (url, options = {}) => {
            fetchCalls.push({ url, options });
            if (mockFetchImpl) {
                const res = await mockFetchImpl(url, options);
                if (res) return res;
            }
            return { status: 200, ok: true, json: async () => ({ ok: true }) };
        };

        const WebSocketMock = function () { return { send() {}, close() {} }; };
        WebSocketMock.OPEN = 1;
        WebSocketMock.CONNECTING = 0;
        WebSocketMock.CLOSING = 2;
        WebSocketMock.CLOSED = 3;

        const sandbox = {
            window: mockWindow,
            document: mockDocument,
            console: { log() {}, error() {}, warn() {} },
            fetch: mockFetch,
            setTimeout() {},
            setInterval() {},
            clearTimeout() {},
            clearInterval() {},
            localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
            URL: global.URL,
            AudioContext: function () {
                return {
                    createAnalyser() { return {}; },
                    createMediaStreamSource() { return {}; },
                    close() { return Promise.resolve(); },
                };
            },
            navigator: { mediaDevices: { getUserMedia: () => Promise.resolve({}) } },
            WebSocket: WebSocketMock,
            testResults: { fetchCalls, listeners, elements },
        };

        vm.createContext(sandbox);
        vm.runInContext(cleanText, sandbox);
        return sandbox;
    }

    // 1. disconnect() must leave the UI in a genuinely disconnected state.
    console.log('Testing disconnect() resets status dot/text and Connect button...');
    {
        const sandbox = createTestSandbox();
        // Simulate "was connected": an OPEN ws, disconnect() reads/uses this.
        const wsStub = { readyState: 1, send() {}, close() {} };
        setLexical(sandbox, 'ws', wsStub);
        setLexical(sandbox, 'currentInteractionId', null);
        setLexical(sandbox, 'acceptedPlaybackGenerationId', null);
        // Pre-seed the button/status elements as if a session was active,
        // the state disconnect() is supposed to correct.
        const connectBtn = sandbox.document.getElementById('connectBtn');
        connectBtn.textContent = 'Disconnect';
        connectBtn.dataset.state = 'connected';
        const avatarStatusDot = sandbox.document.getElementById('avatarStatusDot');
        avatarStatusDot.className = 'status-dot ok';

        sandbox.disconnect();

        assert.strictEqual(connectBtn.dataset.state, 'disconnected', 'connectBtn must switch to the disconnected state');
        assert.notStrictEqual(connectBtn.textContent, 'Disconnect', 'connectBtn must no longer read Disconnect');
        assert.strictEqual(getLexical(sandbox, 'DeviceVisual.getState()'), 'disconnected', 'DeviceVisual must report disconnected, not ready');
        const dotAfter = sandbox.document.getElementById('avatarStatusDot');
        assert.ok(!dotAfter.className.includes('ok'), 'status dot must not still show the green "ok" class');
    }

    // 2. Switching mode while a session is open/connecting must be blocked.
    console.log('Testing voice mode switch is blocked while connected...');
    {
        const sandbox = createTestSandbox();
        setLexical(sandbox, 'selectedRealtimeProvider', 'gemini');
        setLexical(sandbox, 'ws', { readyState: 1 }); // OPEN
        await sandbox.setVoiceMode('tap_to_start');

        assert.strictEqual(getLexical(sandbox, 'voiceMode'), 'hold_to_talk', 'voiceMode must not change while connected');
        const errorBox = sandbox.document.getElementById('voiceModeError');
        assert.strictEqual(errorBox.hidden, false, 'a blocked-switch error must be shown');
        assert.ok(errorBox.textContent.length > 0, 'the blocked-switch error must have a message');
        const voiceModePosts = sandbox.testResults.fetchCalls.filter((c) => c.url === '/api/persona'
            && c.options.method === 'POST'
            && JSON.parse(c.options.body || '{}').voiceMode !== undefined);
        assert.strictEqual(voiceModePosts.length, 0, 'must not attempt to persist a blocked switch');
    }

    // 3. A successful switch while disconnected locks the Connect + mode
    // buttons for the duration of the persist call, then unlocks them.
    console.log('Testing voice mode switch locks/unlocks buttons around the persist call...');
    {
        let resolvePost;
        const postPromise = new Promise((resolve) => { resolvePost = resolve; });
        const fetchImpl = async (url, options) => {
            if (url === '/api/persona' && options.method === 'POST') {
                await postPromise;
                return { status: 200, ok: true, json: async () => ({ ok: true }) };
            }
            return null;
        };
        const sandbox = createTestSandbox(fetchImpl);
        setLexical(sandbox, 'selectedRealtimeProvider', 'gemini');
        setLexical(sandbox, 'ws', null); // fully disconnected

        const switchPromise = sandbox.setVoiceMode('tap_to_start');
        // Give the synchronous portion of setVoiceMode (up through
        // setVoiceModeSwitching(true)) a chance to run before the fetch settles.
        await Promise.resolve();
        await Promise.resolve();

        const connectBtn = sandbox.document.getElementById('connectBtn');
        const holdBtn = sandbox.document.getElementById('voiceModeHoldBtn');
        const tapBtn = sandbox.document.getElementById('voiceModeTapBtn');
        assert.strictEqual(connectBtn.disabled, true, 'Connect button must be disabled while the mode save is in flight');
        assert.strictEqual(holdBtn.disabled, true, 'Hold to Talk button must be disabled while the mode save is in flight');
        assert.strictEqual(tapBtn.disabled, true, 'Tap to Start button must be disabled while the mode save is in flight');

        resolvePost();
        await switchPromise;

        assert.strictEqual(getLexical(sandbox, 'voiceMode'), 'tap_to_start', 'voiceMode must apply after a successful save -- no reload needed');
        assert.strictEqual(connectBtn.disabled, false, 'Connect button must be re-enabled after the save succeeds');
        assert.strictEqual(holdBtn.disabled, false, 'Hold to Talk button must be re-enabled after the save succeeds');
    }

    // 4. A failed persist must revert the mode and leave buttons usable
    // (never a false state).
    console.log('Testing voice mode switch reverts and re-enables buttons on save failure...');
    {
        const fetchImpl = async (url, options) => {
            if (url === '/api/persona' && options.method === 'POST') {
                return { status: 500, ok: false, json: async () => ({ ok: false }) };
            }
            return null;
        };
        const sandbox = createTestSandbox(fetchImpl);
        setLexical(sandbox, 'selectedRealtimeProvider', 'gemini');
        setLexical(sandbox, 'ws', null);

        await sandbox.setVoiceMode('tap_to_start');

        assert.strictEqual(getLexical(sandbox, 'voiceMode'), 'hold_to_talk', 'voiceMode must revert to the previous mode on save failure');
        const connectBtn = sandbox.document.getElementById('connectBtn');
        const holdBtn = sandbox.document.getElementById('voiceModeHoldBtn');
        assert.strictEqual(connectBtn.disabled, false, 'Connect button must not stay locked after a failed save');
        assert.strictEqual(holdBtn.disabled, false, 'mode buttons must not stay locked after a failed save');
        const errorBox = sandbox.document.getElementById('voiceModeError');
        assert.strictEqual(errorBox.hidden, false, 'a save-failure error must be shown');
    }

    console.log('ALL DASHBOARD CONNECTION STATUS & VOICE MODE UI TESTS PASSED!');
    if (require.main === module) {
        process.exit(0);
    }
}

if (require.main === module) {
    run().catch((err) => {
        console.error('Dashboard connection/voice-mode UI tests failed:', err);
        process.exit(1);
    });
}

module.exports = { run };
