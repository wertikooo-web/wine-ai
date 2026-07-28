'use strict';
const { EventEmitter } = require('node:events');
const { GrokVoiceProvider } = require('./src/realtime/grokVoiceProvider');

class FakeGrokSocket extends EventEmitter {
    constructor() {
        super();
        this.readyState = 0;
        process.nextTick(() => { this.readyState = 1; this.emit('open'); });
    }
    send(json) { console.log('SENT', json); }
    close() { this.readyState = 3; this.emit('close', 1000); }
    emitServerMessage(payload) { this.emit('message', Buffer.from(JSON.stringify(payload))); }
}

async function main() {
    let socket;
    const provider = new GrokVoiceProvider({
        apiKey: 'test',
        webSocketFactory: () => { socket = new FakeGrokSocket(); return socket; },
    });
    const session = provider.createSession({ voiceName: 'rigel' });
    const events = [];
    const context = {
        generationId: 'gen1', responseId: 'resp1', turnId: 'turn1',
        turnInputBytes: 0, sessionInputBytes: 0, mode: 'push_to_talk',
        signal: { cancelled: false, cancel: () => {} },
        onSessionEvent: (e) => events.push(['session', e]),
        onEvent: (e) => events.push(['event', e]),
        onAudioChunk: (e) => events.push(['chunk', e]),
        log: (...a) => console.log('LOG', ...a),
    };
    session.beginResponse(context);
    await new Promise((r) => setTimeout(r, 50));
    console.log('socket readyState', socket.readyState);
    socket.emitServerMessage({ type: 'response.output_audio_transcript.delta', delta: 'hello' });
    await new Promise((r) => setTimeout(r, 50));
    console.log('EVENTS', JSON.stringify(events, null, 2));
}
main();
