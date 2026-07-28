'use strict';
const http = require('http');
const { EventEmitter } = require('node:events');
const { attachRealtimeServer } = require('./src/realtime/realtimeServer');
const { GrokVoiceProvider } = require('./src/realtime/grokVoiceProvider');
const { connect } = require('./tests/helpers/wsTestClient');

class FakeGrokSocket extends EventEmitter {
    constructor() {
        super();
        this.readyState = 0;
        process.nextTick(() => { this.readyState = 1; this.emit('open'); });
    }
    send(json) { }
    close() { this.readyState = 3; this.emit('close', 1000); }
    emitServerMessage(payload) { this.emit('message', Buffer.from(JSON.stringify(payload))); }
}

async function main() {
    const sockets = [];
    const grokProvider = new GrokVoiceProvider({
        apiKey: 'test-key',
        webSocketFactory: () => { const s = new FakeGrokSocket(); sockets.push(s); return s; },
    });
    const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    attachRealtimeServer(server, {
        providerFactory: (opts = {}) => grokProvider.createSession(opts),
        providerMetadata: { provider: 'grok', model: 'grok-voice-test', rotationMode: 'errors_only' },
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    const client = await connect(port);
    client.sendJson({ type: 'session.start' });
    await client.waitFor((e) => e.type === 'session.ready' || true, { timeoutMs: 3000 }).catch(() => {});

    client.nextEvent(200).then((e) => console.log('EV', JSON.stringify(e))).catch(() => {});

    // just log everything for a while
    const seen = [];
    const origWait = client.waitFor.bind(client);
    for (let i = 0; i < 3; i++) {
        try {
            const e = await client.nextEvent(500);
            console.log('SEEN', JSON.stringify(e));
        } catch (err) { console.log('no more events yet:', err.message); break; }
    }

    console.log('sockets so far:', sockets.length);

    client.sendJson({ type: 'input_audio.start', mode: 'push_to_talk', interaction_id: 'ix1' });
    for (let i = 0; i < 3; i++) {
        try {
            const e = await client.nextEvent(1000);
            console.log('SEEN2', JSON.stringify(e));
        } catch (err) { console.log('no more events2:', err.message); break; }
    }
    console.log('sockets after turn start:', sockets.length);
    const sock = sockets[sockets.length - 1];
    console.log('socket readyState', sock.readyState);
    await new Promise((r) => setTimeout(r, 100));
    console.log('socket readyState after wait', sock.readyState);
    sock.emitServerMessage({ type: 'response.output_audio_transcript.delta', delta: 'hi' });
    for (let i = 0; i < 3; i++) {
        try {
            const e = await client.nextEvent(1000);
            console.log('SEEN3', JSON.stringify(e));
        } catch (err) { console.log('no more events3:', err.message); break; }
    }
    process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
