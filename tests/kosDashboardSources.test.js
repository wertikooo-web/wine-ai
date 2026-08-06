'use strict';

process.env.NODE_ENV = 'test';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function run() {
    console.log('Running KOS Dashboard UI Unit Tests...');

    // 1. Read dashboard.html and extract the main inline <script> block
    const htmlPath = path.join(__dirname, '../public/dashboard.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    const startIndex = htmlContent.lastIndexOf('<script>');
    const endIndex = htmlContent.lastIndexOf('</script>');
    if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
        throw new Error('Could not find inline <script> block in dashboard.html');
    }
    const scriptText = htmlContent.substring(startIndex + 8, endIndex);

    // Assert that KOS form and list IDs exist in the HTML markup
    assert.ok(htmlContent.includes('id="kosSourceForm"'), 'HTML must contain #kosSourceForm');
    assert.ok(htmlContent.includes('id="kosSourceUrl"'), 'HTML must contain #kosSourceUrl');
    assert.ok(htmlContent.includes('id="kosSourceName"'), 'HTML must contain #kosSourceName');
    assert.ok(htmlContent.includes('id="kosSourceWineryId"'), 'HTML must contain #kosSourceWineryId');
    assert.ok(htmlContent.includes('id="kosSourceList"'), 'HTML must contain #kosSourceList');
    assert.ok(htmlContent.includes('id="tab-documents"'), 'HTML must contain the document storage tab');
    assert.ok(htmlContent.includes('id="storageDocumentList"'), 'HTML must contain the document storage table');
    assert.ok(htmlContent.includes("fetch(`/api/kos/documents?${params}`)"), 'Dashboard must load the read-only KOS documents API');

    // 2. Build mock DOM structures
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
                style: {},
                dataset: {},
                classList: { add() {}, remove() {}, toggle() {} },
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
            if (selector.includes('nav.tabs [data-tab="avatar"]') || selector.includes('[data-tab="avatar"]')) {
                return { click() {}, addEventListener() {} };
            }
            if (selector.startsWith('#')) {
                return getMockElement(selector.slice(1));
            }
            return null;
        },
        querySelectorAll(selector) {
            if (selector === 'nav.tabs button') {
                return [
                    { dataset: { tab: 'avatar' }, classList: { add() {}, remove() {} }, addEventListener() {} },
                    { dataset: { tab: 'knowledge' }, classList: { add() {}, remove() {} }, addEventListener() {} },
                    { dataset: { tab: 'persona' }, classList: { add() {}, remove() {} }, addEventListener() {} }
                ];
            }
            if (selector === 'section.panel') {
                return [
                    { id: 'tab-avatar', classList: { add() {}, remove() {} } },
                    { id: 'tab-knowledge', classList: { add() {}, remove() {} } },
                    { id: 'tab-persona', classList: { add() {}, remove() {} } }
                ];
            }
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

    let fetchCallCount = 0;
    const fetchCalls = [];

    const mockFetch = async (url, options = {}) => {
        fetchCallCount++;
        fetchCalls.push({ url, options });

        if (url === '/api/kos/sources') {
            return {
                status: 200,
                ok: true,
                json: async () => ({
                    ok: true,
                    sources: [
                        {
                            id: 'src_dashboard_test',
                            name: 'Test Winery Website',
                            seed_url: 'https://purcari-ui.wine/en/wines',
                            normalized_origin: 'https://purcari-ui.wine',
                            source_type: 'official_website',
                            trust_level: 'B',
                            winery_id: 'winery_purcari',
                            crawl_status: 'completed',
                            review_status: 'pending_review',
                            last_crawl: {
                                id: 'run_123',
                                status: 'completed',
                                pages_discovered: 10,
                                pages_fetched: 8,
                                pages_failed: 0,
                                documents_created: 5,
                                versions_created: 5,
                            }
                        }
                    ]
                })
            };
        }

        if (url === '/api/kos/sources/website' && options.method === 'POST') {
            const body = JSON.parse(options.body);
            return {
                status: 201,
                ok: true,
                json: async () => ({
                    ok: true,
                    source: {
                        id: 'src_new_dashboard',
                        name: body.name || 'purcari-ui.wine',
                        seed_url: body.url,
                        normalized_origin: 'https://purcari-ui.wine'
                    },
                    crawlStatus: 'completed',
                    reviewStatus: 'pending_review',
                    crawlRun: {
                        id: 'run_new',
                        status: 'completed',
                        pages_fetched: 15
                    }
                })
            };
        }

        return {
            status: 404,
            ok: false,
            json: async () => ({ ok: false, error: 'not_found' })
        };
    };

    // 3. Compile and run script in VM context
    const sandbox = {
        window: mockWindow,
        document: mockDocument,
        console: {
            log: () => {},
            error: () => {},
            warn: () => {}
        },
        fetch: mockFetch,
        setTimeout: () => {},
        setInterval: () => {},
        clearTimeout: () => {},
        clearInterval: () => {},
        localStorage: {
            getItem: () => '',
            setItem: () => {},
            removeItem: () => {}
        },
        URL: global.URL,
        URLSearchParams: global.URLSearchParams,
        location: { protocol: 'https:', host: 'test.local', search: '' },
        // Audio & visual stubs to prevent dashboard.html init errors
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
        }
    };

    vm.createContext(sandbox);
    vm.runInContext(scriptText, sandbox);

    // 4. Validate Event Listeners are bound
    const formSubmitListener = listeners['kosSourceForm_submit'];
    const refreshClickListener = listeners['kosSourcesRefreshBtn_click'];

    assert.ok(formSubmitListener, 'Form submit listener must be registered');
    assert.ok(refreshClickListener, 'Refresh click listener must be registered');

    // 5. Test Polling & Ingestion flow trigger via form submit
    getMockElement('kosSourceUrl').value = 'https://purcari-ui.wine/en/wines';
    getMockElement('kosSourceName').value = 'Purcari UI';
    getMockElement('kosSourceWineryId').value = 'winery_purcari';

    // Invoke Form submit event handler
    const mockEvent = { preventDefault() {} };
    await formSubmitListener(mockEvent);

    // Verify post request payload
    const postCall = fetchCalls.find(c => c.url === '/api/kos/sources/website');
    assert.ok(postCall, 'Form submit must trigger POST /api/kos/sources/website');
    assert.strictEqual(postCall.options.method, 'POST');
    
    const body = JSON.parse(postCall.options.body);
    assert.strictEqual(body.url, 'https://purcari-ui.wine/en/wines');
    assert.strictEqual(body.name, 'Purcari UI');
    assert.strictEqual(body.wineryId, 'winery_purcari');

    // Verify list reloading is called
    const listCall = fetchCalls.find(c => c.url === '/api/kos/sources');
    assert.ok(listCall, 'Form submit must trigger GET /api/kos/sources list reload');

    // Verify UI rendering logic (renders crawl status and source ID card details)
    const listEl = getMockElement('kosSourceList');
    assert.ok(listEl.children.length > 0, 'SourceList should contain rendered elements');
    
    const renderedCard = listEl.children[0];
    assert.strictEqual(renderedCard.tagName, 'DIV');
    assert.ok(renderedCard.className.includes('kos-source-card'));

    console.log('ALL KOS Dashboard UI Unit Tests PASSED!');
    if (require.main === module) {
        process.exit(0);
    }
}

if (require.main === module) {
    run().catch((err) => {
        console.error('UI Unit tests failed:', err);
        process.exit(1);
    });
}
