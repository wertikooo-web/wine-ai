'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const { spawn } = require('child_process');
const t = require('./helpers/assertions');

const FILE_PATH = path.resolve(__dirname, '..', 'data', 'persona-overrides-gender-voice-test-tmp.json');

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

// ---------------------------------------------------------------------------
// PART 1: server-side regression -- GET/POST /api/persona must never null out
// baseProfileId just because a profile has customizations. Nulling it is what
// makes the dashboard fall back to the 'classic' (Alexander) voice defaults
// for a customized Maria (warm_guide) profile.
// ---------------------------------------------------------------------------
async function runServerPart() {
    let child = null;
    const origDbUrl = process.env.DATABASE_URL;
    try {
        if (fs.existsSync(FILE_PATH)) fs.unlinkSync(FILE_PATH);

        child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                PORT: '0',
                DATABASE_URL: '',
                PERSONA_OVERRIDES_FILE: FILE_PATH,
            }
        });

        const portFromOutput = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Server did not report port')), 10000);
            const checkOutput = (data) => {
                const m = data.toString().match(/listening port=(\d+)/i);
                if (m) { clearTimeout(timeout); resolve(Number(m[1])); }
            };
            child.stdout.on('data', checkOutput);
            child.stderr.on('data', checkOutput);
        });

        const resolvedPort = await portFromOutput;
        const BASE = `http://localhost:${resolvedPort}`;
        await waitServer(BASE);

        // 1a. Fresh warm_guide (no overrides at all) must resolve to female --
        // sanity check that resolveProfile()'s own gender fallback is intact.
        const freshRes = await fetch(`${BASE}/api/persona?profileId=warm_guide`);
        const fresh = await freshRes.json();
        t.equal(fresh.sommelierGender, 'female', 'fresh warm_guide (no gender override) resolves to female');
        t.equal(fresh.baseProfileId, 'warm_guide', 'fresh (preset) warm_guide baseProfileId is warm_guide');

        // 1b. Save a non-gender override (style) to warm_guide -- this makes
        // customizationMode become 'custom'. The response's baseProfileId
        // must still say 'warm_guide', not null -- this is the exact field
        // the dashboard uses to pick which profile's default voice to show.
        const saveRes = await fetch(`${BASE}/api/persona`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                profileId: 'warm_guide',
                overrides: { style: { responseLength: 'detailed' } }
            }),
        });
        const saved = await saveRes.json();
        t.equal(saved.customizationMode, 'custom', 'warm_guide becomes custom after a style override');
        t.equal(saved.baseProfileId, 'warm_guide', 'POST /api/persona response: custom warm_guide baseProfileId must stay warm_guide, not null');
        t.equal(saved.sommelierGender, 'female', 'custom warm_guide (still no gender override) stays female');

        // 1c. Re-fetching (GET) the now-custom warm_guide profile must show
        // the same thing -- this is the code path the dashboard actually
        // calls on every page load / profile switch.
        const reloadRes = await fetch(`${BASE}/api/persona?profileId=warm_guide`);
        const reloaded = await reloadRes.json();
        t.equal(reloaded.customizationMode, 'custom', 'GET reflects warm_guide is now custom');
        t.equal(reloaded.baseProfileId, 'warm_guide', 'GET /api/persona response: custom warm_guide baseProfileId must stay warm_guide, not null');

        // 1d. Same check for a customized classic (Alexander) profile, the
        // mirror case -- must not accidentally start reporting 'warm_guide'
        // or null either.
        await fetch(`${BASE}/api/persona`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                profileId: 'classic',
                overrides: { style: { responseLength: 'brief' } }
            }),
        });
        const classicReloadRes = await fetch(`${BASE}/api/persona?profileId=classic`);
        const classicReloaded = await classicReloadRes.json();
        t.equal(classicReloaded.customizationMode, 'custom', 'classic is now custom');
        t.equal(classicReloaded.baseProfileId, 'classic', 'custom classic baseProfileId must stay classic, not null');
        t.equal(classicReloaded.sommelierGender, 'male', 'custom classic (no gender override) stays male');

        console.log('[PASS] Server-side: baseProfileId is never nulled by customization, gender resolves correctly.');
    } finally {
        if (child && !child.killed) {
            child.kill();
            await new Promise(r => setTimeout(r, 200));
        }
        process.env.DATABASE_URL = origDbUrl;
        if (fs.existsSync(FILE_PATH)) fs.unlinkSync(FILE_PATH);
    }
}

// ---------------------------------------------------------------------------
// PART 2: dashboard.html client-side regressions (vm sandbox harness, same
// pattern as tests/dashboardVoiceConfiguration.test.js / dashboardBargeIn.test.js)
// ---------------------------------------------------------------------------
function loadDashboardScript() {
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
    return { htmlContent, cleanText };
}

const MOCK_VOICE_PROVIDERS = [
    {
        id: 'gemini',
        displayName: 'Gemini Live',
        configured: true,
        models: [{
            id: 'gemini-2.0-flash-exp',
            voices: [
                { id: 'Charon', name: 'Charon', displayName: 'Charon', characteristic: 'Спокойный мужской' },
                { id: 'Kore', name: 'Kore', displayName: 'Kore', characteristic: 'Теплый женский' }
            ]
        }]
    },
    {
        id: 'grok',
        displayName: 'Grok Voice',
        configured: true,
        models: [{
            id: 'grok-beta',
            voices: [
                { id: 'rigel', name: 'rigel', displayName: 'rigel', characteristic: 'Глубокий мужской' },
                { id: 'eve', name: 'eve', displayName: 'eve', characteristic: 'Дружелюбный женский' }
            ]
        }]
    }
];

function createTestSandbox(cleanText, fetchImpl) {
    const listeners = {};
    const elements = {};

    function getMockElement(id) {
        if (!elements[id]) {
            elements[id] = {
                id, value: '', textContent: '', innerHTML: '', disabled: false,
                style: {}, dataset: {},
                classList: { add() {}, remove() {}, toggle() {} },
                children: [], listeners: {},
                addEventListener(event, handler) {
                    this.listeners[event] = handler;
                    listeners[`${id}_${event}`] = handler;
                },
                appendChild(child) { this.children.push(child); },
                append(...nodes) { this.children.push(...nodes); },
                setAttribute(k, v) { this[k] = v; },
                removeAttribute(k) { delete this[k]; },
                remove() { this.removed = true; }
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
            if (selector === 'nav.tabs [data-tab="avatar"]') return { click() {}, addEventListener() {} };
            return null;
        },
        querySelectorAll() { return []; },
        createElement(tagName) {
            return {
                tagName: tagName.toUpperCase(), children: [], textContent: '', style: {}, className: '',
                append(...nodes) { this.children.push(...nodes); },
                appendChild(c) { this.children.push(c); },
                addEventListener(event, handler) {
                    if (!this.listeners) this.listeners = {};
                    this.listeners[event] = handler;
                }
            };
        }
    };

    const mockWindow = { addEventListener(event, handler) { listeners[`window_${event}`] = handler; } };

    const fetchCalls = [];
    const mockFetch = async (url, options = {}) => {
        fetchCalls.push({ url, options });
        const res = await fetchImpl(url, options);
        if (res) return res;
        return { status: 200, ok: true, json: async () => ({ ok: true }) };
    };

    const WebSocketMock = function() { return { send() {}, close() {} }; };
    WebSocketMock.OPEN = 1; WebSocketMock.CONNECTING = 0; WebSocketMock.CLOSING = 2; WebSocketMock.CLOSED = 3;

    const sandbox = {
        window: mockWindow,
        document: mockDocument,
        console: { log() {}, error() {}, warn() {} },
        fetch: mockFetch,
        setTimeout() {}, setInterval() {}, clearTimeout() {}, clearInterval() {},
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        URL: global.URL,
        URLSearchParams: global.URLSearchParams,
        location: { protocol: 'https:', host: 'test.local', search: '' },
        AudioContext: function() {
            return { createAnalyser() { return {}; }, createMediaStreamSource() { return {}; }, close() { return Promise.resolve(); } };
        },
        navigator: { mediaDevices: { getUserMedia: () => Promise.resolve({}) } },
        WebSocket: WebSocketMock,
        confirm: () => true,
        testResults: { fetchCalls, listeners, elements }
    };

    vm.createContext(sandbox);
    vm.runInContext(cleanText, sandbox);
    return sandbox;
}

async function runDashboardPart() {
    const { htmlContent, cleanText } = loadDashboardScript();

    // 2a. Fresh (preset) warm_guide profile, no sommelierGender override --
    // the gender <select> must default to 'female', not the hardcoded
    // 'male' fallback.
    console.log('Testing: loading a fresh Maria (warm_guide) profile defaults the gender select to female...');
    {
        const warmGuideFreshResponse = {
            ok: true,
            activeProfileId: 'warm_guide',
            profileId: 'warm_guide',
            baseProfileId: 'warm_guide',
            customizationMode: 'preset',
            mood: 'warm',
            sommelierGender: 'female',
            resolved: { name: 'Мария', sommelierGender: 'female' },
            overrides: {},
            customProfileIds: []
        };
        const fetchImpl = async (url) => {
            if (url === '/api/persona/profiles') return { status: 200, ok: true, json: async () => ({ ok: true, providers: MOCK_VOICE_PROVIDERS, moods: [] }) };
            if (url.startsWith('/api/persona')) return { status: 200, ok: true, json: async () => warmGuideFreshResponse };
            return { status: 200, ok: true, json: async () => ({ ok: true }) };
        };
        const sandbox = createTestSandbox(cleanText, fetchImpl);
        await sandbox.loadPersona('warm_guide');

        const genderSelect = sandbox.document.getElementById('pSommelierGender');
        assert.strictEqual(genderSelect.value, 'female', 'gender select must default to female for a fresh warm_guide (Maria) profile, not the hardcoded male fallback');
    }

    // 2b. A CUSTOM profile based on Maria (warm_guide) must not show
    // Alexander's (classic) voice as the profile default.
    console.log('Testing: a custom profile based on Maria must not offer Alexander\'s voice as the default...');
    {
        const warmGuideCustomResponse = {
            ok: true,
            activeProfileId: 'warm_guide',
            profileId: 'warm_guide',
            baseProfileId: 'warm_guide', // must NOT be null just because it's custom
            customizationMode: 'custom',
            mood: 'warm',
            sommelierGender: 'female',
            resolved: { name: 'Мария', sommelierGender: 'female' },
            overrides: { style: { responseLength: 'detailed' } }, // customized, but no voice override
            customProfileIds: ['warm_guide']
        };
        const fetchImpl = async (url) => {
            if (url === '/api/persona/profiles') return { status: 200, ok: true, json: async () => ({ ok: true, providers: MOCK_VOICE_PROVIDERS, moods: [] }) };
            if (url.startsWith('/api/persona')) return { status: 200, ok: true, json: async () => warmGuideCustomResponse };
            return { status: 200, ok: true, json: async () => ({ ok: true }) };
        };
        const sandbox = createTestSandbox(cleanText, fetchImpl);
        await sandbox.initProvidersConfig();
        await sandbox.renderVoiceSelectors(warmGuideCustomResponse);

        const geminiSelect = sandbox.document.getElementById('vGeminiSelect');
        const defaultOption = geminiSelect.children[0];
        assert.ok(defaultOption, 'gemini voice select must have a default option');
        assert.ok(
            defaultOption.textContent.includes('Kore'),
            `custom Maria (warm_guide) profile's default voice option must reference Kore (Maria's voice), got: "${defaultOption.textContent}"`
        );
        assert.ok(
            !defaultOption.textContent.includes('Charon'),
            `custom Maria (warm_guide) profile's default voice option must NOT reference Charon (Alexander's voice), got: "${defaultOption.textContent}"`
        );
    }

    // 2c. "Сохранить и включить" must save the current draft, THEN activate --
    // never activate stale/previously-saved server data while silently
    // discarding unsaved edits.
    console.log('Testing: Save & Activate persists the current draft before activating...');
    {
        const callOrder = [];
        let savedOverrides = null;
        const fetchImpl = async (url, options) => {
            if (url === '/api/persona/profiles') return { status: 200, ok: true, json: async () => ({ ok: true, providers: MOCK_VOICE_PROVIDERS, moods: [] }) };
            if (url === '/api/persona' && options.method === 'POST') {
                callOrder.push('save');
                savedOverrides = JSON.parse(options.body).overrides;
                return { status: 200, ok: true, json: async () => ({ ok: true, overrides: savedOverrides || {} }) };
            }
            if (url === '/api/persona/activate' && options.method === 'POST') {
                callOrder.push('activate');
                return { status: 200, ok: true, json: async () => ({ ok: true, activeProfileId: 'warm_guide', customProfileIds: ['warm_guide'] }) };
            }
            if (url.startsWith('/api/persona')) {
                return { status: 200, ok: true, json: async () => ({ ok: true, baseProfileId: 'warm_guide', overrides: {}, resolved: {}, customProfileIds: [] }) };
            }
            return { status: 200, ok: true, json: async () => ({ ok: true }) };
        };
        const sandbox = createTestSandbox(cleanText, fetchImpl);
        await sandbox.initProvidersConfig();

        // Simulate the operator having typed a new welcome message into the
        // draft (an unsaved edit) before clicking "Сохранить и включить".
        const editorField = sandbox.document.getElementById('pWelcome');
        editorField.value = 'Новое приветствие от Марии';

        assert.ok(typeof sandbox.saveAndActivatePersona === 'function', 'dashboard.html must expose a combined save+activate function');
        await sandbox.saveAndActivatePersona();

        assert.deepStrictEqual(callOrder, ['save', 'activate'], 'Save & Activate must call save before activate, never the reverse');
        assert.strictEqual(savedOverrides.welcomeMessage, 'Новое приветствие от Марии', 'the current draft edit must actually be sent in the save request, not discarded');
    }

    // 2d. "Сохранить черновик" (draft save) must remain a save-only action --
    // it must never call the activate endpoint.
    console.log('Testing: Save Draft never activates the profile...');
    {
        const callOrder = [];
        const fetchImpl = async (url, options) => {
            if (url === '/api/persona/profiles') return { status: 200, ok: true, json: async () => ({ ok: true, providers: MOCK_VOICE_PROVIDERS, moods: [] }) };
            if (url === '/api/persona' && options.method === 'POST') {
                callOrder.push('save');
                return { status: 200, ok: true, json: async () => ({ ok: true, overrides: {} }) };
            }
            if (url === '/api/persona/activate') {
                callOrder.push('activate');
                return { status: 200, ok: true, json: async () => ({ ok: true, activeProfileId: 'warm_guide', customProfileIds: [] }) };
            }
            if (url.startsWith('/api/persona')) {
                return { status: 200, ok: true, json: async () => ({ ok: true, baseProfileId: 'warm_guide', overrides: {}, resolved: {}, customProfileIds: [] }) };
            }
            return { status: 200, ok: true, json: async () => ({ ok: true }) };
        };
        const sandbox = createTestSandbox(cleanText, fetchImpl);
        await sandbox.initProvidersConfig();
        await sandbox.savePersona();

        assert.deepStrictEqual(callOrder, ['save'], 'Save Draft must only call save, never activate');
    }

    // 2e. UI must surface the active profile's name, voice, and grammatical
    // gender somewhere.
    console.log('Testing: the UI displays the active profile\'s name, voice, and gender...');
    {
        assert.ok(htmlContent.includes('id="activeProfileStatusLine"'), 'dashboard.html must contain an element to display the active profile/voice/gender status');

        const activeWarmGuideResponse = {
            ok: true,
            activeProfileId: 'warm_guide',
            profileId: 'warm_guide',
            baseProfileId: 'warm_guide',
            customizationMode: 'preset',
            mood: 'warm',
            sommelierGender: 'female',
            resolved: { name: 'Мария', sommelierGender: 'female' },
            overrides: {},
            customProfileIds: []
        };
        const fetchImpl = async (url) => {
            if (url === '/api/persona/profiles') return { status: 200, ok: true, json: async () => ({ ok: true, providers: MOCK_VOICE_PROVIDERS, moods: [] }) };
            if (url.startsWith('/api/persona')) return { status: 200, ok: true, json: async () => activeWarmGuideResponse };
            return { status: 200, ok: true, json: async () => ({ ok: true }) };
        };
        const sandbox = createTestSandbox(cleanText, fetchImpl);
        await sandbox.initProvidersConfig();
        await sandbox.loadPersona('warm_guide');

        const statusEl = sandbox.document.getElementById('activeProfileStatusLine');
        assert.ok(statusEl.textContent.includes('Мария'), `active profile status must show the active persona's name, got: "${statusEl.textContent}"`);
        assert.ok(statusEl.textContent.includes('Kore'), `active profile status must show the active voice, got: "${statusEl.textContent}"`);
        assert.ok(/женск/i.test(statusEl.textContent), `active profile status must show the grammatical gender, got: "${statusEl.textContent}"`);
    }

    console.log('[PASS] Dashboard client-side: gender default, voice leakage, save+activate ordering, active-status display.');
}

async function run() {
    console.log('Running Persona Profile Gender/Voice Regression Tests...');
    await runServerPart();
    await runDashboardPart();
    console.log('ALL PERSONA PROFILE GENDER/VOICE REGRESSION TESTS PASSED!');
    if (require.main === module) {
        process.exit(0);
    }
}

module.exports = { run };

if (require.main === module) {
    run().catch((err) => {
        console.error('Persona profile gender/voice regression tests failed:', err);
        process.exit(1);
    });
}
