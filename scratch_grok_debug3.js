'use strict';
const http = require('http');
const { EventEmitter } = require('node:events');
const { attachRealtimeServer } = require('./src/realtime/realtimeServer');
const { GrokVoiceProvider } = require('./src/realtime/grokVoiceProvider');
const { connect } = require('./tests/helpers/wsTestClient');

const WS_OPEN = 1;
class FakeGrokSocket extends EventEmitter {
    constructor() {
        super();
        this.readyState = 0;
        process.nextTick(() => { this.readyState = WS_OPEN; this.emit('open'); });
    }
    send() {}
    close() { this.readyState = 3; this.emit('close', 1000); }
    emitServerMessage(payload) { this.emit('message', Buffer.from(JSON.stringify(payload))); }
}

async function waitForSocket(sockets, index, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (sockets.length > index && sockets[index].readyState === WS_OPEN) return sockets[index];
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timeout waiting for socket[${index}] to open (have ${sockets.length})`);
}

async function startTurn(client, interactionId) {
    client.sendJson({ type: 'input_audio.start', mode: 'push_to_talk', interaction_id: interactionId });
    const started = await client.waitFor((e) => e.type === 'input_audio.start', { label: 'echo', timeoutMs: 3000 });
    return started.turn_id;
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
    await client.waitFor((e) => e.type === 'session.ready', { timeoutMs: 3000 });
    client.sendJson({ type: 'session.start' });
    await client.waitFor((e) => e.type === 'provider.ready', { timeoutMs: 3000 });
    console.log('provider ready, sockets:', sockets.length);

    const socketA = await waitForSocket(sockets, sockets.length - 1);
    console.log('got socketA');
    const turn2TurnId = await startTurn(client, 'ix_turn2');
    console.log('turn2 started', turn2TurnId);
    client.sendBinary(Buffer.alloc(320));
    client.sendJson({ type: 'input_audio.end' });
    console.log('sent binary+end, emitting delta now');
    socketA.emitServerMessage({ type: 'response.output_audio_transcript.delta', delta: 'hello' });
    console.log('delta emitted, waiting for transcript.model...');
    const ev = await client.waitFor((e) => e.type === 'transcript.model' && e.turn_id === turn2TurnId, { timeoutMs: 3000 });
    console.log('GOT IT', JSON.stringify(ev));
    process.exit(0);
}
main().catch((e) => { console.error('FAILED', e); process.exit(1); });
