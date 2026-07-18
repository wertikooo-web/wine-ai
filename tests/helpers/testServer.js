'use strict';

const http = require('http');
const { attachRealtimeServer } = require('../../src/realtime/realtimeServer');
const { MockRealtimeProvider, DEFAULT_CONFIG } = require('../../src/realtime/mockRealtimeProvider');
const { TOOL_DECLARATIONS, createToolHandlers } = require('../../src/tools');
const { createSessionMemory } = require('../../src/memory/sessionMemory');

// Boots a real HTTP+WS server on an ephemeral port with the mock provider
// (fast, deterministic, no API key) — used by the realtime lifecycle tests.
// Tests can override the mock provider's timing via `mockConfig` (e.g. a
// long processingDelayMs so a test has time to interrupt/cancel mid-turn).
function startTestServer({ mockConfig = {} } = {}) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            res.writeHead(404);
            res.end();
        });
        const mockProvider = new MockRealtimeProvider({ ...DEFAULT_CONFIG, ...mockConfig });
        attachRealtimeServer(server, {
            providerFactory: (sessionOptions = {}) => mockProvider.createSession(sessionOptions),
            providerMetadata: {
                provider: 'mock',
                model: 'mock',
                contentToolsEnabled: true,
                toolDeclarations: TOOL_DECLARATIONS,
                createToolHandlers,
                createSessionMemory,
            },
        });
        server.listen(0, () => {
            resolve({
                port: server.address().port,
                // NOTE: this sandbox's loopback networking does not always
                // deliver socket teardown back to a listening http.Server
                // after a hijacked (post-upgrade) socket is destroyed —
                // confirmed with a minimal reproduction using bare Node
                // http/net and no project code at all, so server.close()'s
                // callback can never fire even with closeAllConnections().
                // Each test uses a fresh OS-assigned port (`listen(0)`), so
                // waiting for a clean close between tests isn't actually
                // needed for isolation — best-effort close with a short
                // grace period, then move on regardless.
                close: () => {
                    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
                    server.close();
                    return new Promise((res) => setTimeout(res, 50));
                },
            });
        });
    });
}

module.exports = { startTestServer };
