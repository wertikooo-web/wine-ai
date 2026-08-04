'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function run() {
    console.log('Running Dashboard Voice Configuration & Migration Unit Tests...');

    // 1. Read dashboard.html and extract the main inline <script> block
    const htmlPath = path.join(__dirname, '../public/dashboard.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    const startIndex = htmlContent.lastIndexOf('<script>');
    const endIndex = htmlContent.lastIndexOf('</script>');
    if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
        throw new Error('Could not find inline <script> block in dashboard.html');
    }
    const scriptText = htmlContent.substring(startIndex + 8, endIndex);

    // Strip the outer IIFE wrapper so that declared variables/functions become properties of the sandbox context
    let cleanText = scriptText;
    cleanText = cleanText.replace("(function () {", "");
    cleanText = cleanText.replace("'use strict';", "");
    const lastIndex = cleanText.lastIndexOf("})();");
    if (lastIndex !== -1) {
        cleanText = cleanText.substring(0, lastIndex) + cleanText.substring(lastIndex + 5);
    }

    // Assert that markup contains new selectors
    assert.ok(htmlContent.includes('id="vGeminiSelect"'), 'HTML must contain #vGeminiSelect');
    assert.ok(htmlContent.includes('id="vGrokSelect"'), 'HTML must contain #vGrokSelect');
    assert.ok(htmlContent.includes('id="vGeminiStatus"'), 'HTML must contain #vGeminiStatus');
    assert.ok(htmlContent.includes('id="vGrokStatus"'), 'HTML must contain #vGrokStatus');
    assert.ok(htmlContent.includes('id="vGeminiInfo"'), 'HTML must contain #vGeminiInfo');
    assert.ok(htmlContent.includes('id="vGrokInfo"'), 'HTML must contain #vGrokInfo');
    assert.ok(htmlContent.includes('id="voiceConfigStatus"'), 'HTML must contain #voiceConfigStatus');
    assert.ok(htmlContent.includes('id="legacyVoiceSection"'), 'HTML must contain #legacyVoiceSection');
    assert.ok(htmlContent.includes('id="knowledgeEvaluationPanel"'), 'HTML must contain the text knowledge evaluation panel');
    assert.ok(htmlContent.includes('id="evalStartBtn"'), 'HTML must contain the evaluation auto-run button');
    assert.ok(htmlContent.includes('id="evalStopBtn"'), 'HTML must contain the evaluation stop button');
    assert.ok(htmlContent.includes('id="evalExportCsvBtn"'), 'HTML must contain CSV export');
    assert.ok(htmlContent.includes("'/api/knowledge/evaluate'"), 'Dashboard evaluation must use the text evaluation API');
    assert.ok(htmlContent.includes('evaluationState.running'), 'Dashboard evaluation must have an explicit stop-controlled run state');

    // Standard mock responses
    const mockProfilesResponse = {
        ok: true,
        providers: [
            {
                id: 'gemini',
                displayName: 'Gemini Live',
                configured: true,
                models: [
                    {
                        id: 'gemini-2.0-flash-exp',
                        voices: [
                            { id: 'Charon', name: 'Charon', characteristic: 'Спокойный мужской' },
                            { id: 'Kore', name: 'Kore', characteristic: 'Теплый женский' },
                            { id: 'Zephyr', name: 'Zephyr', characteristic: 'Воздушный мужской' }
                        ]
                    }
                ]
            },
            {
                id: 'grok',
                displayName: 'Grok Voice',
                configured: true,
                models: [
                    {
                        id: 'grok-beta',
                        voices: [
                            { id: 'rigel', name: 'rigel', characteristic: 'Глубокий мужской' },
                            { id: 'eve', name: 'eve', characteristic: 'Дружелюбный женский' }
                        ]
                    }
                ]
            }
        ]
    };

    const mockPersonaResponseEmpty = {
        ok: true,
        baseProfileId: 'classic',
        mood: 'calm',
        overrides: {}
    };

    // Helper to set lexical variables inside VM context
    function setLexical(sandbox, varName, value) {
        sandbox._tmpVal = value;
        vm.runInContext(`${varName} = _tmpVal; delete _tmpVal;`, sandbox);
    }

    // Helper to build sandbox for each test case
    function createTestSandbox(initialStore = {}, mockFetchImpl = null) {
        const listeners = {};
        const elements = {};
        const localStore = { ...initialStore };

        function getMockElement(id) {
            if (!elements[id]) {
                elements[id] = {
                    id,
                    value: '',
                    textContent: '',
                    innerHTML: '',
                    disabled: false,
                    style: {},
                    dataset: {},
                    classList: {
                        add() {},
                        remove() {},
                        toggle() {}
                    },
                    children: [],
                    listeners: {},
                    addEventListener(event, handler) {
                        this.listeners[event] = handler;
                        listeners[`${id}_${event}`] = handler;
                    },
                    appendChild(child) {
                        this.children.push(child);
                    },
                    append(...nodes) {
                        this.children.push(...nodes);
                    },
                    setAttribute(k, v) {
                        this[k] = v;
                    },
                    removeAttribute(k) {
                        delete this[k];
                    },
                    remove() {
                        this.removed = true;
                    }
                };
            }
            return elements[id];
        }

        const mockDocument = {
            getElementById: getMockElement,
            addEventListener(event, handler) {
                listeners[`document_${event}`] = handler;
            },
            createTextNode(text) {
                return { text };
            },
            querySelector(selector) {
                if (selector.startsWith('#')) {
                    return getMockElement(selector.slice(1));
                }
                if (selector === 'nav.tabs [data-tab="avatar"]') {
                    return { click() {}, addEventListener() {} };
                }
                if (selector.includes('p:last-child')) {
                    return { textContent: '' };
                }
                return null;
            },
            querySelectorAll(selector) {
                return [];
            },
            createElement(tagName) {
                return {
                    tagName: tagName.toUpperCase(),
                    children: [],
                    textContent: '',
                    style: {},
                    className: '',
                    append(...nodes) {
                        this.children.push(...nodes);
                    },
                    appendChild(c) {
                        this.children.push(c);
                    },
                    addEventListener(event, handler) {
                        if (!this.listeners) this.listeners = {};
                        this.listeners[event] = handler;
                    }
                };
            }
        };

        const mockWindow = {
            addEventListener(event, handler) {
                listeners[`window_${event}`] = handler;
            }
        };

        const fetchCalls = [];
        const mockFetch = async (url, options = {}) => {
            fetchCalls.push({ url, options });
            if (mockFetchImpl) {
                const res = await mockFetchImpl(url, options);
                if (res) return res;
            }
            return {
                status: 200,
                ok: true,
                json: async () => ({ ok: true })
            };
        };

        const mockLocalStorage = {
            getItem(key) {
                return localStore[key] || null;
            },
            setItem(key, val) {
                localStore[key] = String(val);
            },
            removeItem(key) {
                delete localStore[key];
            }
        };

        const WebSocketMock = function() {
            return {
                send() {},
                close() {}
            };
        };
        WebSocketMock.OPEN = 1;
        WebSocketMock.CONNECTING = 0;
        WebSocketMock.CLOSING = 2;
        WebSocketMock.CLOSED = 3;

        const sandbox = {
            window: mockWindow,
            document: mockDocument,
            console: {
                log() {},
                error() {},
                warn() {}
            },
            fetch: mockFetch,
            setTimeout() {},
            setInterval() {},
            clearTimeout() {},
            clearInterval() {},
            localStorage: mockLocalStorage,
            URL: global.URL,
            URLSearchParams: global.URLSearchParams,
            location: { protocol: 'https:', host: 'test.local', search: '' },
            AudioContext: function() {
                return {
                    createAnalyser() { return {}; },
                    createMediaStreamSource() { return {}; },
                    close() { return Promise.resolve(); }
                };
            },
            navigator: {
                mediaDevices: {
                    getUserMedia: () => Promise.resolve({})
                }
            },
            WebSocket: WebSocketMock,
            // Store results for the test runner to inspect
            testResults: {
                fetchCalls,
                localStore,
                listeners,
                elements
            }
        };

        vm.createContext(sandbox);
        vm.runInContext(cleanText, sandbox);
        return sandbox;
    }

    // 1. Validate session.start never contains voiceName
    console.log('Testing session.start payload...');
    {
        const sandbox = createTestSandbox();
        setLexical(sandbox, 'selectedVoiceName', 'Charon');
        let sentPayload = null;
        const wsStub = {
            readyState: 1, // OPEN
            send(payloadStr) {
                sentPayload = JSON.parse(payloadStr);
            }
        };
        setLexical(sandbox, 'ws', wsStub);
        sandbox.sendSessionStart();
        assert.strictEqual(sentPayload.type, 'session.start');
        assert.strictEqual(sentPayload.voiceName, undefined, 'session.start must never contain voiceName');
    }

    // 2. Validate migration logic: both Gemini and Grok in one pass
    console.log('Testing concurrent legacy migration...');
    {
        const initialStore = {
            'wineAiVoiceName:gemini': 'Zephyr',
            'wineAiVoiceName:grok': 'eve',
            'wine_ai_voice_settings_migrated_v2': 'false'
        };

        let savedPayload = null;
        const fetchImpl = async (url, options) => {
            const method = options.method || 'GET';
            if (url === '/api/persona/profiles') {
                return { status: 200, ok: true, json: async () => mockProfilesResponse };
            }
            if (url === '/api/persona' && method === 'POST') {
                savedPayload = JSON.parse(options.body);
                return { status: 200, ok: true, json: async () => ({ ok: true }) };
            }
            if (url.startsWith('/api/persona') && method === 'GET') {
                return { status: 200, ok: true, json: async () => mockPersonaResponseEmpty };
            }
            if (url.startsWith('/api/voices')) {
                return { status: 200, ok: true, json: async () => ({ ok: true, providers: [] }) };
            }
        };

        const sandbox = createTestSandbox(initialStore, fetchImpl);

        // Run functions sequentially as if startup block ran
        setLexical(sandbox, 'globalProvidersConfig', null);
        await sandbox.initProvidersConfig();
        const data = await sandbox.loadPersona();
        await sandbox.handleLegacyMigration(data);

        // Verify correct sparse migration payload
        assert.ok(savedPayload, 'Migration must issue a POST request');
        assert.deepStrictEqual(savedPayload.overrides.runtimeByProvider, {
            gemini: { voiceId: 'Zephyr' },
            grok: { voiceId: 'eve' }
        }, 'Must migrate both valid legacy voices in a single sparse payload');

        // Verify cleanup in localStore
        const store = sandbox.testResults.localStore;
        assert.strictEqual(store['wineAiVoiceName:gemini'], undefined, 'Must clean up gemini legacy key');
        assert.strictEqual(store['wineAiVoiceName:grok'], undefined, 'Must clean up grok legacy key');
        assert.strictEqual(store['wine_ai_voice_settings_migrated_v2'], 'true', 'Must set migration marker v2');
    }

    // 3. Server override is not overwritten by legacy values
    console.log('Testing that server overrides are not overwritten by legacy values...');
    {
        const initialStore = {
            'wineAiVoiceName:gemini': 'Zephyr',
            'wine_ai_voice_settings_migrated_v2': 'false'
        };
        const mockPersonaResponseWithServerOverride = {
            ok: true,
            baseProfileId: 'classic',
            mood: 'calm',
            overrides: {
                runtimeByProvider: {
                    gemini: { voiceId: 'Kore' } // Already set on server
                }
            }
        };
        let savedPayload = null;
        const fetchImpl = async (url, options) => {
            const method = options.method || 'GET';
            if (url === '/api/persona/profiles') {
                return { status: 200, ok: true, json: async () => mockProfilesResponse };
            }
            if (url === '/api/persona' && method === 'POST') {
                savedPayload = JSON.parse(options.body);
                return { status: 200, ok: true, json: async () => ({ ok: true }) };
            }
            if (url.startsWith('/api/persona') && method === 'GET') {
                return { status: 200, ok: true, json: async () => mockPersonaResponseWithServerOverride };
            }
            if (url.startsWith('/api/voices')) {
                return { status: 200, ok: true, json: async () => ({ ok: true, providers: [] }) };
            }
        };

        const sandbox = createTestSandbox(initialStore, fetchImpl);
        await sandbox.initProvidersConfig();
        const data = await sandbox.loadPersona();
        await sandbox.handleLegacyMigration(data);

        assert.strictEqual(savedPayload, null, 'Must NOT trigger migration POST if server overrides already exist');
        const store = sandbox.testResults.localStore;
        assert.strictEqual(store['wineAiVoiceName:gemini'], undefined, 'Must still delete legacy keys as they are superseded');
        assert.strictEqual(store['wine_ai_voice_settings_migrated_v2'], 'true', 'Must set migration marker');
    }

    // 4. Old wineAiVoiceName is used only as Gemini fallback
    console.log('Testing old wineAiVoiceName fallback for Gemini...');
    {
        const initialStore = {
            'wineAiVoiceName': 'Kore',
            'wine_ai_voice_settings_migrated_v2': 'false'
        };
        let savedPayload = null;
        const fetchImpl = async (url, options) => {
            const method = options.method || 'GET';
            if (url === '/api/persona/profiles') {
                return { status: 200, ok: true, json: async () => mockProfilesResponse };
            }
            if (url === '/api/persona' && method === 'POST') {
                savedPayload = JSON.parse(options.body);
                return { status: 200, ok: true, json: async () => ({ ok: true }) };
            }
            if (url.startsWith('/api/persona') && method === 'GET') {
                return { status: 200, ok: true, json: async () => mockPersonaResponseEmpty };
            }
            if (url.startsWith('/api/voices')) {
                return { status: 200, ok: true, json: async () => ({ ok: true, providers: [] }) };
            }
        };

        const sandbox = createTestSandbox(initialStore, fetchImpl);
        await sandbox.initProvidersConfig();
        const data = await sandbox.loadPersona();
        await sandbox.handleLegacyMigration(data);

        assert.deepStrictEqual(savedPayload.overrides.runtimeByProvider, {
            gemini: { voiceId: 'Kore' }
        }, 'Must migrate old fallback key only to Gemini provider');
        const store = sandbox.testResults.localStore;
        assert.strictEqual(store['wineAiVoiceName'], undefined, 'Must delete legacy fallback key');
    }

    // 5. Marker is not set upon failed POST
    console.log('Testing failed POST migration safety...');
    {
        const initialStore = {
            'wineAiVoiceName:gemini': 'Zephyr',
            'wine_ai_voice_settings_migrated_v2': 'false'
        };
        const fetchImpl = async (url, options) => {
            const method = options.method || 'GET';
            if (url === '/api/persona/profiles') {
                return { status: 200, ok: true, json: async () => mockProfilesResponse };
            }
            if (url === '/api/persona' && method === 'POST') {
                return { status: 400, ok: false, json: async () => ({ ok: false, error: 'invalid_data' }) };
            }
            if (url.startsWith('/api/persona') && method === 'GET') {
                return { status: 200, ok: true, json: async () => mockPersonaResponseEmpty };
            }
            if (url.startsWith('/api/voices')) {
                return { status: 200, ok: true, json: async () => ({ ok: true, providers: [] }) };
            }
        };

        const sandbox = createTestSandbox(initialStore, fetchImpl);
        await sandbox.initProvidersConfig();
        const data = await sandbox.loadPersona();
        await sandbox.handleLegacyMigration(data);

        const store = sandbox.testResults.localStore;
        assert.strictEqual(store['wine_ai_voice_settings_migrated_v2'], 'false', 'Migration marker must not be set on failure');
        assert.strictEqual(store['wineAiVoiceName:gemini'], 'Zephyr', 'Legacy keys must not be deleted on failure');
    }

    // 6. Resetting voice returns default profile voice
    console.log('Testing voiceId: null reset...');
    {
        let savedPayload = null;
        const fetchImpl = async (url, options) => {
            const method = options.method || 'GET';
            if (url === '/api/persona/profiles') {
                return { status: 200, ok: true, json: async () => mockProfilesResponse };
            }
            if (url === '/api/persona' && method === 'POST') {
                savedPayload = JSON.parse(options.body);
                return { status: 200, ok: true, json: async () => ({ ok: true }) };
            }
            if (url.startsWith('/api/persona') && method === 'GET') {
                return { status: 200, ok: true, json: async () => mockPersonaResponseEmpty };
            }
            if (url.startsWith('/api/voices')) {
                return { status: 200, ok: true, json: async () => ({ ok: true, providers: [] }) };
            }
        };

        const sandbox = createTestSandbox({}, fetchImpl);
        await sandbox.initProvidersConfig();
        await sandbox.loadPersona();

        const geminiSelect = sandbox.document.getElementById('vGeminiSelect');
        const changeHandler = geminiSelect.listeners['change'];
        assert.ok(changeHandler, 'Gemini select must register a change listener');

        geminiSelect.value = ''; // Profile default
        await changeHandler();
        assert.deepStrictEqual(savedPayload.overrides.runtimeByProvider.gemini, { voiceId: null }, 'Resetting to default must send voiceId: null');
    }

    // 7. Modifying one provider preserves another
    console.log('Testing that modifying one provider preserves the other...');
    {
        const mockPersonaResponseWithGrokOverride = {
            ok: true,
            baseProfileId: 'classic',
            mood: 'calm',
            overrides: {
                runtimeByProvider: {
                    grok: { voiceId: 'eve' }
                }
            }
        };

        let savedPayload = null;
        const fetchImpl = async (url, options) => {
            const method = options.method || 'GET';
            if (url === '/api/persona/profiles') {
                return { status: 200, ok: true, json: async () => mockProfilesResponse };
            }
            if (url === '/api/persona' && method === 'POST') {
                savedPayload = JSON.parse(options.body);
                return { status: 200, ok: true, json: async () => ({ ok: true }) };
            }
            if (url.startsWith('/api/persona') && method === 'GET') {
                return { status: 200, ok: true, json: async () => ({
                    ok: true,
                    overrides: {
                        runtimeByProvider: {
                            gemini: { voiceId: 'Zephyr' },
                            grok: { voiceId: 'eve' }
                        }
                    }
                }) };
            }
            if (url.startsWith('/api/voices')) {
                return { status: 200, ok: true, json: async () => ({ ok: true, providers: [] }) };
            }
        };

        const sandbox = createTestSandbox({}, fetchImpl);
        await sandbox.initProvidersConfig();
        
        // Render initial UI state with the Grok override
        await sandbox.renderVoiceSelectors(mockPersonaResponseWithGrokOverride);

        const geminiSelect = sandbox.document.getElementById('vGeminiSelect');
        const changeHandler = geminiSelect.listeners['change'];

        geminiSelect.value = 'Zephyr';
        await changeHandler();

        // Verify sparse POST only has the changed provider
        assert.deepStrictEqual(savedPayload, {
            profileId: 'classic',
            overrides: {
                runtimeByProvider: {
                    gemini: { voiceId: 'Zephyr' }
                }
            }
        }, 'POST body must be a sparse update and not touch other provider overrides');
    }

    // 8. Active profile badge keeps readable text on the wine background
    console.log('Testing active profile badge contrast...');
    {
        const sandbox = createTestSandbox();
        sandbox.updateProfileButtons('classic', 'classic', []);
        const activeBadge = sandbox.document.getElementById('activeProfileBadge');
        assert.strictEqual(activeBadge.textContent, 'Active Sommelier');
        assert.strictEqual(activeBadge.style.background, 'var(--wine)');
        assert.strictEqual(activeBadge.style.color, 'white', 'Active profile badge text must remain readable on the wine background');
    }

    console.log('ALL DASHBOARD VOICE CONFIGURATION UNIT TESTS PASSED!');
    if (require.main === module) {
        process.exit(0);
    }
}

if (require.main === module) {
    run().catch((err) => {
        console.error('Targeted dashboard unit tests failed:', err);
        process.exit(1);
    });
}
