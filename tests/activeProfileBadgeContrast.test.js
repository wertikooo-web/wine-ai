'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
    return cleanText;
}

function createTestSandbox(cleanText) {
    const elements = {};
    function getMockElement(id) {
        if (!elements[id]) {
            elements[id] = {
                id, value: '', textContent: '', innerHTML: '', disabled: false,
                style: {}, dataset: {},
                classList: { add() {}, remove() {}, toggle() {} },
                children: [], listeners: {},
                addEventListener(event, handler) { this.listeners[event] = handler; },
                appendChild(child) { this.children.push(child); },
                append(...nodes) { this.children.push(...nodes); },
                replaceChildren(...nodes) { this.children = nodes; },
                setAttribute(k, v) { this[k] = v; },
                removeAttribute(k) { delete this[k]; },
                remove() { this.removed = true; }
            };
        }
        return elements[id];
    }
    const mockDocument = {
        getElementById: getMockElement,
        addEventListener() {},
        createTextNode(text) { return { text }; },
        querySelector(selector) {
            if (selector.startsWith('#')) return getMockElement(selector.slice(1));
            return null;
        },
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
    const sandbox = {
        window: { addEventListener() {} },
        document: mockDocument,
        console: { log() {}, error() {}, warn() {} },
        fetch: async () => ({ status: 200, ok: true, json: async () => ({ ok: true }) }),
        setTimeout() {}, setInterval() {}, clearTimeout() {}, clearInterval() {},
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        URL: global.URL,
        URLSearchParams: global.URLSearchParams,
        location: { protocol: 'https:', host: 'test.local', search: '' },
        AudioContext: function() {
            return { createAnalyser() { return {}; }, createMediaStreamSource() { return {}; }, close() { return Promise.resolve(); } };
        },
        navigator: { mediaDevices: { getUserMedia: () => Promise.resolve({}) } },
        testResults: { elements },
    };
    vm.createContext(sandbox);
    vm.runInContext(cleanText, sandbox);
    return sandbox;
}

async function run() {
    console.log('Running Active Profile Badge Contrast Regression Test...');
    const cleanText = loadDashboardScript();

    // "Active Sommelier" uses a colored (--wine) background; without an
    // explicit white text color it inherits the page's default text color,
    // which can render illegibly against that background depending on
    // theme. "Editing Draft" (muted background) needs the same treatment
    // for consistency.
    console.log('Testing: the active-profile badge always sets an explicit white text color...');
    {
        const sandbox = createTestSandbox(cleanText);
        sandbox.document.getElementById('activeProfileBadge');

        vm.runInContext("updateProfileButtons('classic', 'classic')", sandbox);
        const activeBadge = sandbox.testResults.elements.activeProfileBadge;
        assert.strictEqual(activeBadge.textContent, 'Active Sommelier', 'sanity: editor matches active profile');
        assert.strictEqual(activeBadge.style.color, 'white', 'Active Sommelier badge must have explicit white text color for contrast');

        vm.runInContext("updateProfileButtons('classic', 'warm_guide')", sandbox);
        assert.strictEqual(activeBadge.textContent, 'Editing Draft', 'sanity: editor now differs from active profile');
        assert.strictEqual(activeBadge.style.color, 'white', 'Editing Draft badge must also have explicit white text color for contrast');
    }

    console.log('ALL ACTIVE PROFILE BADGE CONTRAST TESTS PASSED!');
    if (require.main === module) {
        process.exit(0);
    }
}

module.exports = { run };

if (require.main === module) {
    run().catch((err) => {
        console.error('Active profile badge contrast test failed:', err);
        process.exit(1);
    });
}
