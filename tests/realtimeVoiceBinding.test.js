'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const t = require('./helpers/assertions');
const { connect } = require('./helpers/wsTestClient');
const { attachRealtimeServer } = require('../src/realtime/realtimeServer');
const { resolveProfile } = require('../src/persona/profileRegistry');
const { GEMINI_VOICES } = require('../src/geminiVoices');
const { GROK_VOICES } = require('../src/grokVoices');

// Set temporary overrides file path to avoid touching production files
const FILE_PATH = path.resolve(__dirname, '..', 'data', 'persona-overrides-test-tmp.json');
process.env.PERSONA_OVERRIDES_FILE = FILE_PATH;

const personaStore = require('../src/persona/personaStore');

function startCustomTestServer({ providerId, defaultVoice, voices = [] } = {}) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            res.writeHead(404);
            res.end();
        });

        const lastSessionOptions = [];

        attachRealtimeServer(server, {
            resolveProvider: (requestedProvider) => {
                return {
                    id: providerId,
                    metadata: {
                        provider: providerId,
                        model: 'test-model',
                        defaultVoiceName: defaultVoice,
                        voices
                    },
                    createSession: (sessionOptions) => {
                        lastSessionOptions.push(sessionOptions);
                        return {
                            instanceId: 'test-instance',
                            voiceName: sessionOptions.voiceName,
                            systemInstructionMeta: {},
                            close() {},
                            destroySession() {}
                        };
                    }
                };
            }
        });

        server.listen(0, () => {
            resolve({
                port: server.address().port,
                lastSessionOptions,
                close: () => {
                    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
                    server.close();
                    return new Promise((res) => setTimeout(res, 50));
                }
            });
        });
    });
}

async function run() {
    let assertionCount = 0;
    
    // Clean out temporary test overrides file
    if (fs.existsSync(FILE_PATH)) fs.unlinkSync(FILE_PATH);

    const origAllowLegacy = process.env.REALTIME_ALLOW_LEGACY_VOICE_OVERRIDE;
    const origDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = '';

    try {
        console.log('Running Realtime Voice Session Binding Tests (Phase 2A2)...');

        // ==========================================
        // 1. GEMINI BINDING PRESETS
        // ==========================================
        {
            // Preset: classic -> Gemini gets Charon
            await personaStore.save({ baseProfileId: 'classic', overrides: {} });
            const { port, lastSessionOptions, close } = await startCustomTestServer({
                providerId: 'gemini',
                defaultVoice: 'Kore',
                voices: GEMINI_VOICES.map(v => ({ id: v.name, name: v.name }))
            });

            try {
                const client = await connect(port);
                await client.waitFor((e) => e.type === 'session.ready');
                client.sendJson({ type: 'session.start', voiceName: '' });
                await client.waitFor((e) => e.type === 'session.config.applied');

                t.equal(lastSessionOptions.length, 2, 'Two sessions created (initial + session.start config)');
                const activeOpts = lastSessionOptions[1];
                t.equal(activeOpts.voiceName, 'Charon', 'Gemini classic preset defaults to Charon');
                t.equal(activeOpts.voiceConfigSource, 'profile_default', 'voiceConfigSource is profile_default');
                assertionCount += 3;
                client.close();
            } finally {
                await close();
            }
        }

        {
            // Preset: warm_guide -> Gemini gets Kore
            await personaStore.save({ baseProfileId: 'warm_guide', overrides: {} });
            const { port, lastSessionOptions, close } = await startCustomTestServer({
                providerId: 'gemini',
                defaultVoice: 'Charon',
                voices: GEMINI_VOICES.map(v => ({ id: v.name, name: v.name }))
            });

            try {
                const client = await connect(port);
                await client.waitFor((e) => e.type === 'session.ready');
                client.sendJson({ type: 'session.start' });
                await client.waitFor((e) => e.type === 'session.config.applied');

                const activeOpts = lastSessionOptions[1];
                t.equal(activeOpts.voiceName, 'Kore', 'Gemini warm_guide preset defaults to Kore');
                t.equal(activeOpts.voiceConfigSource, 'profile_default', 'voiceConfigSource is profile_default');
                assertionCount += 2;
                client.close();
            } finally {
                await close();
            }
        }

        // ==========================================
        // 2. GROK BINDING PRESETS
        // ==========================================
        {
            // Preset: classic -> Grok gets rigel
            await personaStore.save({ baseProfileId: 'classic', overrides: {} });
            const { port, lastSessionOptions, close } = await startCustomTestServer({
                providerId: 'grok',
                defaultVoice: 'altair',
                voices: GROK_VOICES
            });

            try {
                const client = await connect(port);
                await client.waitFor((e) => e.type === 'session.ready');
                client.sendJson({ type: 'session.start' });
                await client.waitFor((e) => e.type === 'session.config.applied');

                const activeOpts = lastSessionOptions[1];
                t.equal(activeOpts.voiceName, 'rigel', 'Grok classic preset defaults to rigel');
                assertionCount += 1;
                client.close();
            } finally {
                await close();
            }
        }

        {
            // Preset: warm_guide -> Grok gets eve
            await personaStore.save({ baseProfileId: 'warm_guide', overrides: {} });
            const { port, lastSessionOptions, close } = await startCustomTestServer({
                providerId: 'grok',
                defaultVoice: 'altair',
                voices: GROK_VOICES
            });

            try {
                const client = await connect(port);
                await client.waitFor((e) => e.type === 'session.ready');
                client.sendJson({ type: 'session.start' });
                await client.waitFor((e) => e.type === 'session.config.applied');

                const activeOpts = lastSessionOptions[1];
                t.equal(activeOpts.voiceName, 'eve', 'Grok warm_guide preset defaults to eve');
                assertionCount += 1;
                client.close();
            } finally {
                await close();
            }
        }

        // ==========================================
        // 3. PRIORITY RESOLUTION (Server Override & Legacy Client Voice)
        // ==========================================
        {
            // Server override set: Zephyr
            // Legacy client voice requested: Leda
            // Result: Zephyr wins (server override > legacy client)
            await personaStore.save({ baseProfileId: 'classic' });
            await personaStore.save({
                overrides: {
                    runtimeByProvider: {
                        gemini: { voiceId: 'Zephyr' }
                    }
                }
            });

            const { port, lastSessionOptions, close } = await startCustomTestServer({
                providerId: 'gemini',
                defaultVoice: 'Kore',
                voices: GEMINI_VOICES.map(v => ({ id: v.name, name: v.name }))
            });

            try {
                const client = await connect(port);
                await client.waitFor((e) => e.type === 'session.ready');
                client.sendJson({ type: 'session.start', voiceName: 'Leda' });
                await client.waitFor((e) => e.type === 'session.config.applied');

                const activeOpts = lastSessionOptions[1];
                t.equal(activeOpts.voiceName, 'Zephyr', 'Server override wins over legacy client voice');
                t.equal(activeOpts.voiceConfigSource, 'server_override', 'ConfigSource is server_override');
                assertionCount += 2;
                client.close();
            } finally {
                await close();
            }
        }

        {
            // No server override, legacy voice allowed
            // Legacy client voice: Leda
            // Result: Leda wins (legacy client > preset default)
            process.env.REALTIME_ALLOW_LEGACY_VOICE_OVERRIDE = 'true';
            await personaStore.save({ baseProfileId: 'classic', overrides: {} });

            const { port, lastSessionOptions, close } = await startCustomTestServer({
                providerId: 'gemini',
                defaultVoice: 'Kore',
                voices: GEMINI_VOICES.map(v => ({ id: v.name, name: v.name }))
            });

            try {
                const client = await connect(port);
                await client.waitFor((e) => e.type === 'session.ready');
                client.sendJson({ type: 'session.start', voiceName: 'Leda' });
                await client.waitFor((e) => e.type === 'session.config.applied');

                const activeOpts = lastSessionOptions[1];
                t.equal(activeOpts.voiceName, 'Leda', 'Legacy client voice applied when allowed');
                t.equal(activeOpts.voiceConfigSource, 'legacy_client', 'ConfigSource is legacy_client');
                assertionCount += 2;
                client.close();
            } finally {
                await close();
            }
        }

        // ==========================================
        // 4. LEGACY COMPATIBILITY TOGGLE & FALLBACKS
        // ==========================================
        {
            // Legacy voice disallowed via env flag
            // Result: defaults to preset (Charon)
            process.env.REALTIME_ALLOW_LEGACY_VOICE_OVERRIDE = 'false';
            await personaStore.save({ baseProfileId: 'classic', overrides: {} });

            const { port, lastSessionOptions, close } = await startCustomTestServer({
                providerId: 'gemini',
                defaultVoice: 'Kore',
                voices: GEMINI_VOICES.map(v => ({ id: v.name, name: v.name }))
            });

            try {
                const client = await connect(port);
                await client.waitFor((e) => e.type === 'session.ready');
                client.sendJson({ type: 'session.start', voiceName: 'Leda' });
                await client.waitFor((e) => e.type === 'session.config.applied');

                const activeOpts = lastSessionOptions[1];
                t.equal(activeOpts.voiceName, 'Charon', 'Legacy client voice ignored when disallowed');
                assertionCount += 1;
                client.close();
            } finally {
                await close();
            }
        }

        {
            // Invalid legacy voice fallback
            // Result: falls back to preset (Charon) without crashing
            process.env.REALTIME_ALLOW_LEGACY_VOICE_OVERRIDE = 'true';
            await personaStore.save({ baseProfileId: 'classic', overrides: {} });

            const { port, lastSessionOptions, close } = await startCustomTestServer({
                providerId: 'gemini',
                defaultVoice: 'Kore',
                voices: GEMINI_VOICES.map(v => ({ id: v.name, name: v.name }))
            });

            try {
                const client = await connect(port);
                await client.waitFor((e) => e.type === 'session.ready');
                client.sendJson({ type: 'session.start', voiceName: 'invalid-voice-name-xyz' });
                await client.waitFor((e) => e.type === 'session.config.applied');

                const activeOpts = lastSessionOptions[1];
                t.equal(activeOpts.voiceName, 'Charon', 'Invalid legacy voice falls back to preset default safely');
                assertionCount += 1;
                client.close();
            } finally {
                await close();
            }
        }

        // ==========================================
        // 5. SESSION IMMUTABILITY
        // ==========================================
        {
            // Modify profile mid-session -> session re-resolves on next session.start
            await personaStore.save({ baseProfileId: 'classic', overrides: {} });
            const { port, lastSessionOptions, close } = await startCustomTestServer({
                providerId: 'gemini',
                defaultVoice: 'Kore',
                voices: GEMINI_VOICES.map(v => ({ id: v.name, name: v.name }))
            });

            try {
                const client = await connect(port);
                await client.waitFor((e) => e.type === 'session.ready');
                client.sendJson({ type: 'session.start' });
                await client.waitFor((e) => e.type === 'session.config.applied');

                t.equal(lastSessionOptions[1].voiceName, 'Charon', 'Initial resolution is Charon');

                // Update settings in database/store mid-session
                await personaStore.save({ baseProfileId: 'warm_guide', overrides: {} });

                // Send a second session.start -> snapshot is rebuilt with new profile
                client.sendJson({ type: 'session.start' });
                await client.waitFor((e) => e.type === 'session.config.applied');

                t.equal(lastSessionOptions[2].voiceName, 'Kore', 'Active session voice changes on second session.start (snapshot rebuilt)');
                assertionCount += 2;
                client.close();
            } finally {
                await close();
            }
        }

        console.log(`[PASS] tests/realtimeVoiceBinding.test.js: All ${assertionCount} assertions passed successfully.`);
    } finally {
        process.env.DATABASE_URL = origDbUrl;
        if (fs.existsSync(FILE_PATH)) fs.unlinkSync(FILE_PATH);
        if (origAllowLegacy !== undefined) {
            process.env.REALTIME_ALLOW_LEGACY_VOICE_OVERRIDE = origAllowLegacy;
        } else {
            delete process.env.REALTIME_ALLOW_LEGACY_VOICE_OVERRIDE;
        }
    }
}

module.exports = { run };

if (require.main === module) {
    run().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
