'use strict';

const http = require('http');
const { attachRealtimeServer } = require('../src/realtime/realtimeServer');
const { MockRealtimeProvider, DEFAULT_CONFIG } = require('../src/realtime/mockRealtimeProvider');
const { connect } = require('./helpers/wsTestClient');
const t = require('./helpers/assertions');

function start({ isAdultVerified }) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => res.end());
        const provider = new MockRealtimeProvider(DEFAULT_CONFIG);
        attachRealtimeServer(server, {
            providerFactory: (options) => provider.createSession(options),
            providerMetadata: { provider: 'mock', model: 'mock', contentToolsEnabled: false },
            isAdultVerified,
        });
        server.listen(0, () => resolve({
            port: server.address().port,
            close: () => { server.closeAllConnections?.(); server.close(); },
        }));
    });
}

async function appliedAccess(port, headers = {}) {
    const client = await connect(port, '/realtime', headers);
    try {
        await client.waitFor((event) => event.type === 'session.ready');
        // The client must not be able to grant itself access through the
        // session.start JSON payload.
        client.sendJson({ type: 'session.start', sampleRate: 16000, isAdultVerified: true });
        const applied = await client.waitFor((event) => event.type === 'session.config.applied');
        return applied.access.adult_verified;
    } finally {
        client.close();
    }
}

async function run() {
    const server = await start({ isAdultVerified: (req) => req.headers.cookie === 'approved=yes' });
    try {
        t.equal(await appliedAccess(server.port), false, 'unverified WebSocket must keep pairing tools blocked');
        t.equal(await appliedAccess(server.port, { Cookie: 'approved=yes' }), true, 'server-verified request cookie must enable adult-only tools');
    } finally {
        server.close();
    }
}

module.exports = { run };
