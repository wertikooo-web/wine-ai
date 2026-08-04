'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { resolveProfile } = require('../src/persona/profileRegistry');
const personaStore = require('../src/persona/personaStore');
const { getEffectivePersonaPrompt, buildProfileRuntimePrompt } = require('../src/persona/wineExpertPersona');

async function run() {
    console.log('Running Phase 2C Conversation Freedom & Fine-Tuning Unit Tests...');
    const origDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = '';

    // ==========================================
    // 1. Defaults Verification
    // ==========================================
    console.log('Checking default configuration settings...');
    const resolvedClassic = resolveProfile('classic', {}, 'calm');
    assert.strictEqual(resolvedClassic.style.conversationMode, 'friendly');
    assert.strictEqual(resolvedClassic.style.askFollowUpQuestions, true);
    assert.strictEqual(resolvedClassic.style.useHumor, true);
    assert.strictEqual(resolvedClassic.style.talkAboutSelf, true);
    assert.strictEqual(resolvedClassic.style.supportSmallTalk, true);
    assert.strictEqual(resolvedClassic.style.softlyReturnToWine, true);
    assert.strictEqual(resolvedClassic.style.useFictionalBiography, false);
    assert.strictEqual(resolvedClassic.style.responseLength, 'balanced');
    assert.strictEqual(resolvedClassic.style.responseVariety, 'natural');

    // ==========================================
    // 2. Overrides Validation Verification
    // ==========================================
    console.log('Checking overrides validation in personaStore...');

    // Valid cases
    await personaStore.save({
        overrides: {
            style: {
                conversationMode: 'free',
                responseLength: 'brief',
                responseVariety: 'expressive',
                askFollowUpQuestions: false,
                useFictionalBiography: true
            }
        }
    });
    let cached = personaStore.getCached();
    assert.strictEqual(cached.overrides.style.conversationMode, 'free');
    assert.strictEqual(cached.overrides.style.responseLength, 'brief');
    assert.strictEqual(cached.overrides.style.responseVariety, 'expressive');
    assert.strictEqual(cached.overrides.style.askFollowUpQuestions, false);
    assert.strictEqual(cached.overrides.style.useFictionalBiography, true);

    // Invalid enum values (should fail)
    try {
        await personaStore.save({
            overrides: {
                style: {
                    conversationMode: 'invalid_mode'
                }
            }
        });
        assert.fail('Should have failed on invalid conversationMode');
    } catch (err) {
        assert.strictEqual(err.statusCode, 400);
    }

    try {
        await personaStore.save({
            overrides: {
                style: {
                    responseLength: 'short' // 'short' is no longer allowed in validation
                }
            }
        });
        assert.fail('Should have failed on short responseLength');
    } catch (err) {
        assert.strictEqual(err.statusCode, 400);
    }

    // Invalid boolean types (should fail)
    try {
        await personaStore.save({
            overrides: {
                style: {
                    useHumor: 'true'
                }
            }
        });
        assert.fail('Should have failed on string type for boolean flag');
    } catch (err) {
        assert.strictEqual(err.statusCode, 400);
    }

    // Reset settings
    await personaStore.save({ reset: true });

    // ==========================================
    // 3. Prompt Block & Semantic Markers Verification
    // ==========================================
    console.log('Checking prompt compiler semantic markers...');

    // Strict Mode
    const promptStrict = buildProfileRuntimePrompt({
        style: {
            conversationMode: 'strict',
            responseLength: 'brief',
            responseVariety: 'stable',
            softlyReturnToWine: true,
            useFictionalBiography: false
        }
    });
    assert.ok(promptStrict.includes('CONVERSATION MODE: STRICT'), 'Strict mode title must be present');
    assert.ok(promptStrict.includes('Я прежде всего винный эксперт'), 'Strict redirection instruction must be present');
    assert.ok(promptStrict.includes('RESPONSE LENGTH: BRIEF'), 'Brief length indicator must be present');
    assert.ok(promptStrict.includes('STYLE VARIETY: STABLE'), 'Stable variety indicator must be present');

    // Free Mode with Fictional Biography Enabled
    const promptFree = buildProfileRuntimePrompt({
        style: {
            conversationMode: 'free',
            responseLength: 'detailed',
            responseVariety: 'expressive',
            useFictionalBiography: true
        }
    });
    assert.ok(promptFree.includes('CONVERSATION MODE: FREE TALK'), 'Free talk title must be present');
    assert.ok(promptFree.includes('RESPONSE LENGTH: DETAILED'), 'Detailed length indicator must be present');
    assert.ok(promptFree.includes('STYLE VARIETY: EXPRESSIVE'), 'Expressive variety indicator must be present');
    assert.ok(promptFree.includes('maintain a transparent frame'), 'Biography frame warning must be present');
    assert.ok(promptFree.includes('politics or war'), 'Politics restrictions must be present');

    // Friendly Mode with Fictional Biography Disabled
    const promptFriendly = buildProfileRuntimePrompt({
        style: {
            conversationMode: 'friendly',
            responseLength: 'balanced',
            responseVariety: 'natural',
            useFictionalBiography: false
        }
    });
    assert.ok(promptFriendly.includes('CONVERSATION MODE: FRIENDLY'), 'Friendly mode title must be present');
    assert.ok(promptFriendly.includes('Do not invent any personal backstory'), 'Biography disabled directive must be present');

    // Check absence of contradictory statements
    assert.ok(!promptFriendly.includes('CONVERSATION MODE: STRICT'), 'Friendly prompt must not contain Strict markers');
    assert.ok(!promptFriendly.includes('CONVERSATION MODE: FREE TALK'), 'Friendly prompt must not contain Free Talk markers');

    // ==========================================
    // 4. Session Snapshot Immutability Verification
    // ==========================================
    console.log('Checking session snapshot immutability...');
    // Realtime server copies the resolved profile compile payload into a session snapshot during wsProtocol setup.
    // Let's verify that getEffectivePersonaPrompt() doesn't mutate previous compile results when settings are changed.
    const beforePrompt = getEffectivePersonaPrompt();

    // Save draft settings
    await personaStore.save({
        overrides: {
            style: {
                conversationMode: 'strict'
            }
        }
    });

    const afterPrompt = getEffectivePersonaPrompt();
    assert.notStrictEqual(beforePrompt, afterPrompt, 'Prompt preview must change on save');

    // Revert change
    await personaStore.save({ reset: true });

    // ==========================================
    // 5. Dashboard DOM Load & Save Integration
    // ==========================================
    console.log('Checking dashboard.html DOM integration via Node VM...');
    const htmlPath = path.join(__dirname, '../public/dashboard.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');

    // Verify HTML selectors exist
    assert.ok(htmlContent.includes('id="pStyleConversationMode"'), 'HTML must contain #pStyleConversationMode select');
    assert.ok(htmlContent.includes('id="pStyleVariety"'), 'HTML must contain #pStyleVariety select');
    assert.ok(htmlContent.includes('id="pStyleAskFollowUpQuestions"'), 'HTML must contain #pStyleAskFollowUpQuestions checkbox');
    assert.ok(htmlContent.includes('id="pStyleUseHumor"'), 'HTML must contain #pStyleUseHumor checkbox');
    assert.ok(htmlContent.includes('id="pStyleTalkAboutSelf"'), 'HTML must contain #pStyleTalkAboutSelf checkbox');
    assert.ok(htmlContent.includes('id="pStyleSupportSmallTalk"'), 'HTML must contain #pStyleSupportSmallTalk checkbox');
    assert.ok(htmlContent.includes('id="pStyleSoftlyReturnToWine"'), 'HTML must contain #pStyleSoftlyReturnToWine checkbox');
    assert.ok(htmlContent.includes('id="pStyleUseFictionalBiography"'), 'HTML must contain #pStyleUseFictionalBiography checkbox');

    // Read and parse script tag for mock evaluation
    const startIndex = htmlContent.lastIndexOf('<script>');
    const endIndex = htmlContent.lastIndexOf('</script>');
    let scriptText = htmlContent.substring(startIndex + 8, endIndex);

    // Strip outer IIFE wrapper
    scriptText = scriptText.replace("(function () {", "");
    scriptText = scriptText.replace("'use strict';", "");
    const lastIndex = scriptText.lastIndexOf("})();");
    if (lastIndex !== -1) {
        scriptText = scriptText.substring(0, lastIndex) + scriptText.substring(lastIndex + 5);
    }

    // Set up JSDOM context mock
    const elements = {};
    function mockElement(id) {
        if (!elements[id]) {
            elements[id] = {
                id,
                value: '',
                checked: false,
                textContent: '',
                innerHTML: '',
                style: {},
                dataset: {},
                classList: {
                    toggle: () => {},
                    add: () => {},
                    remove: () => {}
                },
                children: [],
                addEventListener: () => {},
                appendChild(c) {
                    this.children.push(c);
                },
                removeChild(c) {
                    const idx = this.children.indexOf(c);
                    if (idx !== -1) this.children.splice(idx, 1);
                }
            };
        }
        return elements[id];
    }

    const localStore = {};
    const sandbox = {
        document: {
            getElementById: (id) => mockElement(id),
            querySelectorAll: () => [],
            querySelector: (sel) => {
                if (sel === 'nav.tabs [data-tab="avatar"]') {
                    return { click() {}, addEventListener() {} };
                }
                return mockElement('dummy');
            },
            addEventListener: () => {},
            createElement: (tagName) => ({
                tagName: tagName.toUpperCase(),
                children: [],
                textContent: '',
                style: {},
                className: '',
                append() {},
                appendChild() {},
                addEventListener() {}
            })
        },
        window: {
            addEventListener: () => {}
        },
        localStorage: {
            getItem(key) {
                return localStore[key] || null;
            },
            setItem(key, val) {
                localStore[key] = String(val);
            },
            removeItem(key) {
                delete localStore[key];
            }
        },
        el: (id) => mockElement(id),
        fetch: async (url, options) => {
            if (url === '/api/persona' && (!options || options.method === 'GET')) {
                return {
                    ok: true,
                    json: async () => ({
                        baseProfileId: 'classic',
                        customizationMode: 'preset',
                        mood: 'calm',
                        resolved: {
                            style: {
                                conversationMode: 'friendly',
                                responseLength: 'balanced',
                                responseVariety: 'natural',
                                askFollowUpQuestions: true,
                                useHumor: true,
                                talkAboutSelf: true,
                                supportSmallTalk: true,
                                softlyReturnToWine: true,
                                useFictionalBiography: false
                            }
                        }
                    })
                };
            }
            if (url === '/api/persona' && options && options.method === 'POST') {
                const body = JSON.parse(options.body);
                // Verify structure
                assert.ok(body.overrides, 'POST overrides property must be present');
                assert.strictEqual(body.overrides.style.conversationMode, 'strict');
                assert.strictEqual(body.overrides.style.responseLength, 'brief');
                assert.strictEqual(body.overrides.style.useFictionalBiography, true);
                return {
                    ok: true,
                    json: async () => ({ ok: true })
                };
            }
            return { ok: true, json: async () => ({}) };
        },
        console: {
            log: () => {},
            warn: () => {},
            error: () => {}
        },
        setTimeout: (fn) => fn(),
        URL: global.URL,
        URLSearchParams: global.URLSearchParams,
        location: { protocol: 'https:', host: 'test.local', search: '' },
        log: () => {},
        initProvidersConfig: async () => {},
        handleLegacyMigration: async () => {},
        loadVoices: async () => {},
        renderVoiceSelectors: async () => {},
        WebSocket: function() {
            return {
                send() {},
                close() {}
            };
        }
    };
    sandbox.WebSocket.OPEN = 1;
    sandbox.WebSocket.CONNECTING = 0;
    sandbox.WebSocket.CLOSING = 2;
    sandbox.WebSocket.CLOSED = 3;

    vm.createContext(sandbox);
    vm.runInContext(scriptText, sandbox);

    // Test loadPersona maps database fields to DOM
    await sandbox.loadPersona();
    assert.strictEqual(mockElement('pStyleConversationMode').value, 'friendly');
    assert.strictEqual(mockElement('pStyleLength').value, 'balanced');
    assert.strictEqual(mockElement('pStyleVariety').value, 'natural');
    assert.strictEqual(mockElement('pStyleAskFollowUpQuestions').checked, true);
    assert.strictEqual(mockElement('pStyleUseFictionalBiography').checked, false);

    // Test savePersona correctly serializes DOM overrides
    mockElement('pStyleConversationMode').value = 'strict';
    mockElement('pStyleLength').value = 'brief';
    mockElement('pStyleUseFictionalBiography').checked = true;

    await sandbox.savePersona();

    console.log('ALL PHASE 2C CONVERSATION SETTINGS TESTS PASSED SUCCESSFULLY!');
    process.env.DATABASE_URL = origDbUrl;
}

if (require.main === module) {
    run().catch(err => {
        console.error('Test execution failed:', err);
        process.exit(1);
    });
}
