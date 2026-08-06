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
    return { htmlContent, cleanText };
}

function createTestSandbox(cleanText, fetchImpl) {
    const listeners = {};
    const elements = {};
    let capturedBlob = null;

    function getMockElement(id) {
        if (!elements[id]) {
            elements[id] = {
                id, value: '', textContent: '', innerHTML: '', disabled: false,
                style: {}, dataset: {}, checked: false,
                classList: { add() {}, remove() {}, toggle() {} },
                children: [], listeners: {},
                addEventListener(event, handler) {
                    this.listeners[event] = handler;
                    listeners[`${id}_${event}`] = handler;
                },
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

    function createMockNode(tagName) {
        const node = {
            tagName: tagName.toUpperCase(), children: [], textContent: '', style: {}, className: '',
            value: '', rows: 0, placeholder: '', href: '', download: '',
            listeners: {},
            append(...nodes) { this.children.push(...nodes); },
            appendChild(c) { this.children.push(c); return c; },
            addEventListener(event, handler) { this.listeners[event] = handler; },
            click() {},
        };
        return node;
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
        createElement: createMockNode,
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

    const timers = [];
    const sandbox = {
        window: mockWindow,
        document: mockDocument,
        console: { log() {}, error() {}, warn() {} },
        fetch: mockFetch,
        // Evaluation's pause-between-questions uses real setTimeout; resolve
        // immediately so the loop tests run fast and deterministically.
        setTimeout(fn) { timers.push(fn); fn(); return timers.length; },
        setInterval() {}, clearTimeout() {}, clearInterval() {},
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        URL: {
            createObjectURL(blob) { capturedBlob = blob; return 'blob:mock'; },
            revokeObjectURL() {},
        },
        URLSearchParams: global.URLSearchParams,
        location: { protocol: 'https:', host: 'test.local', search: '' },
        Blob: function(parts, opts) { this.parts = parts; this.type = opts && opts.type; },
        AudioContext: function() {
            return { createAnalyser() { return {}; }, createMediaStreamSource() { return {}; }, close() { return Promise.resolve(); } };
        },
        navigator: { mediaDevices: { getUserMedia: () => Promise.resolve({}) } },
        WebSocket: WebSocketMock,
        confirm: () => true,
        testResults: { fetchCalls, listeners, elements, getCapturedBlob: () => capturedBlob }
    };

    vm.createContext(sandbox);
    vm.runInContext(cleanText, sandbox);
    return sandbox;
}

function getLexical(sandbox, expr) {
    return vm.runInContext(expr, sandbox);
}
function setLexical(sandbox, varName, value) {
    sandbox._tmpVal = value;
    vm.runInContext(`${varName} = _tmpVal; delete _tmpVal;`, sandbox);
}

const OK_EVALUATE_RESPONSE = (question) => ({
    status: 200, ok: true,
    json: async () => ({
        ok: true, question, language: 'ru', answer: `Ответ на: ${question}`,
        found: true, evidence: [{ level: 'documents', title: 'T', source: 'https://example.md', text: 'x' }],
        used_levels: ['documents'], web_used: false, duration_ms: 42, usage: null,
    }),
});

async function run() {
    console.log('Running Text Knowledge Evaluation UI Regression Tests...');
    const { cleanText } = loadDashboardScript();

    // 1. comment reaches state, JSON export, and CSV export -----------------
    console.log('Testing: a reviewer comment ends up in state, JSON export, and CSV export...');
    {
        const fetchImpl = async (url) => {
            if (url === '/api/knowledge/evaluate') return OK_EVALUATE_RESPONSE('Что такое Фетяска Нягрэ?');
            return null;
        };
        const sandbox = createTestSandbox(cleanText, fetchImpl);
        sandbox.document.getElementById('evalQuestions').value = 'Что такое Фетяска Нягрэ?';
        sandbox.document.getElementById('evalLanguage').value = 'ru';

        setLexical(sandbox, 'evaluationState.questions', ['Что такое Фетяска Нягрэ?']);
        await getLexical(sandbox, 'runEvaluationOne()');

        // A freshly produced result must always carry a comment field,
        // defaulted to an empty string -- never undefined/missing.
        const comment0 = getLexical(sandbox, 'evaluationState.results[0].comment');
        assert.strictEqual(comment0, '', 'a fresh result must have comment defaulted to an empty string');

        // Simulate the operator typing into the comment textarea -- the
        // real UI wires this via an input listener that writes directly to
        // evaluationState.results[index].comment.
        setLexical(sandbox, 'evaluationState.results[0].comment', 'Проверено вручную, ответ корректный');

        const exportedJson = await (async () => {
            getLexical(sandbox, 'exportEvaluation("json")');
            const blob = sandbox.testResults.getCapturedBlob();
            assert.ok(blob, 'exportEvaluation("json") must create a Blob');
            assert.strictEqual(blob.type, 'application/json', 'JSON export must use an application/json Blob type');
            return JSON.parse(blob.parts[0]);
        })();
        assert.strictEqual(exportedJson[0].comment, 'Проверено вручную, ответ корректный', 'JSON export row must include the reviewer comment');

        getLexical(sandbox, 'exportEvaluation("csv")');
        const csvBlob = sandbox.testResults.getCapturedBlob();
        assert.strictEqual(csvBlob.type, 'text/csv;charset=utf-8', 'CSV export must use a text/csv Blob type');
        const csvContent = csvBlob.parts[0];
        assert.ok(csvContent.includes('comment'), 'CSV header row must include a comment column');
        assert.ok(csvContent.includes('Проверено вручную, ответ корректный'), 'CSV data row must include the reviewer comment text');
    }

    // 1b. A fail-open answerability outcome (grader unavailable/unparseable)
    //     must never render identically to a genuinely confirmed answer --
    //     otherwise an outage in the grader silently looks like full
    //     verification to whoever is reading the eval panel.
    console.log('Testing: a fail-open answerability result is visibly distinct from a real confirmation in the UI...');
    {
        const fetchImpl = async (url) => {
            if (url === '/api/knowledge/evaluate') {
                return {
                    status: 200, ok: true,
                    json: async () => ({
                        ok: true, question: 'Вопрос?', language: 'ru', answer: 'Некий ответ.',
                        // Matches the real API contract: a fail-open/unknown
                        // check is reported as answerable:false (never true),
                        // with the reason naming exactly what happened.
                        found: true, answerable: false, answerability_reason: 'answerability_check_unavailable',
                        evidence: [{ level: 'documents', title: 'T', source: 'https://example.md', text: 'x' }],
                        used_levels: ['documents'], web_used: false, duration_ms: 10, usage: null,
                    }),
                };
            }
            return null;
        };
        const sandbox = createTestSandbox(cleanText, fetchImpl);
        setLexical(sandbox, 'evaluationState.questions', ['Вопрос?']);
        await getLexical(sandbox, 'runEvaluationOne()');

        // Mock createElement objects don't auto-aggregate textContent from
        // children the way real DOM nodes do -- read the meta line directly
        // off the card's children (question, answer, meta, grades, comment).
        const card = sandbox.document.getElementById('evalResults').children[0];
        const metaText = card.children[2].textContent;
        assert.ok(metaText.includes('проверка ответности недоступна') || metaText.includes('не подтверждено'),
            `a fail-open result must show explicit unverified wording, not a plain confirmation. Got: "${metaText}"`);
        assert.ok(!metaText.startsWith('Есть источники ·'),
            `the meta line must not read as a bare, unqualified "Есть источники" when the check never actually ran. Got: "${metaText}"`);
    }

    // 2. Next after the last question never silently wipes results ---------
    console.log('Testing: clicking Next after the run has completed does not discard results...');
    {
        const fetchImpl = async (url) => {
            if (url === '/api/knowledge/evaluate') return OK_EVALUATE_RESPONSE('Единственный вопрос?');
            return null;
        };
        const sandbox = createTestSandbox(cleanText, fetchImpl);
        sandbox.document.getElementById('evalQuestions').value = 'Единственный вопрос?';

        const nextHandler = sandbox.testResults.listeners['evalNextBtn_click'];
        assert.ok(nextHandler, 'evalNextBtn must have a click listener registered');

        // First click: loads the single question from the textarea and
        // answers it -- this exhausts the queue immediately.
        await nextHandler();
        assert.strictEqual(getLexical(sandbox, 'evaluationState.results.length'), 1, 'the first Next click must produce exactly one result');
        assert.strictEqual(sandbox.document.getElementById('evalNextBtn').disabled, true, 'Next must be disabled once the run is complete');
        assert.strictEqual(sandbox.document.getElementById('evalStatus').textContent, getLexical(sandbox, 'EVALUATION_COMPLETE_MESSAGE'), 'the completion message must be shown, not a silent reset');

        // Second click (simulating a stray click that bypasses the disabled
        // attribute, e.g. a queued event) must NOT wipe the existing result.
        await nextHandler();
        assert.strictEqual(getLexical(sandbox, 'evaluationState.results.length'), 1, 'a second Next click after completion must not silently discard the completed run\'s results');
        assert.strictEqual(getLexical(sandbox, 'evaluationState.results[0].question'), 'Единственный вопрос?', 'the original result must still be intact after the second click');
    }

    // 3. Existing Start/Stop/Next behavior does not regress -----------------
    console.log('Testing: Start runs the full queue to completion (no regression)...');
    {
        const questions = ['Вопрос 1?', 'Вопрос 2?'];
        const fetchImpl = async (url, options) => {
            if (url === '/api/knowledge/evaluate') {
                const q = JSON.parse(options.body).question;
                return OK_EVALUATE_RESPONSE(q);
            }
            return null;
        };
        const sandbox = createTestSandbox(cleanText, fetchImpl);
        sandbox.document.getElementById('evalQuestions').value = questions.join('\n');
        sandbox.document.getElementById('evalPauseMs').value = '0';

        const startHandler = sandbox.testResults.listeners['evalStartBtn_click'];
        assert.ok(startHandler, 'evalStartBtn must have a click listener registered');
        await startHandler();
        // The Start handler kicks off an async loop without awaiting it
        // internally (matches the pre-existing implementation) -- give the
        // mocked, synchronously-resolving setTimeout-driven loop a moment.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(getLexical(sandbox, 'evaluationState.results.length'), 2, 'Start must run every loaded question to completion');
        assert.strictEqual(sandbox.document.getElementById('evalStopBtn').disabled, true, 'Stop must be disabled again once the run completes');
    }

    console.log('Testing: Stop halts the queue after the current in-flight question...');
    {
        // "Current" means whatever request is in-flight at the exact moment
        // Stop is clicked -- it is allowed to finish, but no further
        // question may ever start after that.
        let releaseFirst;
        const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
        let callCount = 0;
        const fetchImpl = async (url, options) => {
            if (url !== '/api/knowledge/evaluate') return null;
            callCount++;
            const q = JSON.parse(options.body).question;
            if (callCount === 1) {
                await firstGate;
                return OK_EVALUATE_RESPONSE(q);
            }
            throw new Error('a second question must never start once Stop has been clicked');
        };
        const sandbox = createTestSandbox(cleanText, fetchImpl);
        sandbox.document.getElementById('evalQuestions').value = ['A?', 'B?', 'C?'].join('\n');
        sandbox.document.getElementById('evalPauseMs').value = '0';

        const startHandler = sandbox.testResults.listeners['evalStartBtn_click'];
        const stopHandler = sandbox.testResults.listeners['evalStopBtn_click'];
        await startHandler();
        // The loop is now suspended mid-flight on question A. Click Stop
        // while it is still pending, then let it resolve.
        stopHandler();
        releaseFirst();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(callCount, 1, 'no second question may ever be dispatched once Stop was clicked during the first request');
        assert.strictEqual(getLexical(sandbox, 'evaluationState.results.length'), 1, 'only the in-flight question at the moment of Stop completes; the queue does not continue');
    }

    console.log('ALL TEXT KNOWLEDGE EVALUATION UI REGRESSION TESTS PASSED!');
    if (require.main === module) {
        process.exit(0);
    }
}

module.exports = { run };

if (require.main === module) {
    run().catch((err) => {
        console.error('Text knowledge evaluation UI regression tests failed:', err);
        process.exit(1);
    });
}
