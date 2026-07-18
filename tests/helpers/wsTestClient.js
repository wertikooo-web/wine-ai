'use strict';

// Minimal WebSocket test client — deliberately reuses the transport core's
// OWN framing code (src/realtime/wsProtocol.js's sendJson/sendBinary and
// createFrameParser) rather than adding a `ws` npm dependency just for
// tests. wsProtocol.js's frame parser only unmasks a frame if the mask bit
// is set, so an unmasked client frame (as sendJson/sendBinary produce) is
// accepted by the real server exactly like a masked browser frame would be.
const http = require('http');
const crypto = require('crypto');
const { sendJson, sendBinary, createFrameParser } = require('../../src/realtime/wsProtocol');

function connect(port, path = '/realtime') {
    return new Promise((resolve, reject) => {
        const key = crypto.randomBytes(16).toString('base64');
        const req = http.request({
            port,
            path,
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Version': 13,
                'Sec-WebSocket-Key': key,
            },
        });

        req.on('upgrade', (res, socket, head) => {
            const buffered = [];
            const waiters = [];

            function push(event) {
                if (waiters.length) waiters.shift()(event);
                else buffered.push(event);
            }

            const parser = createFrameParser({
                onText: (text) => {
                    try { push(JSON.parse(text)); } catch { /* ignore malformed */ }
                },
                onBinary: () => {},
                onClose: () => {},
            });
            socket.on('data', (chunk) => parser.push(chunk));
            socket.on('error', () => {});
            // `head` holds any bytes the HTTP client already read past the
            // 101 response before handing the socket over — the server
            // commonly writes its first WS frame (session.ready) fast
            // enough to land in the same TCP segment, so this is not an
            // edge case to skip.
            if (head && head.length) parser.push(head);

            resolve({
                sendJson: (payload) => sendJson(socket, payload),
                sendBinary: (buffer) => sendBinary(socket, buffer),
                nextEvent(timeoutMs = 3000) {
                    if (buffered.length) return Promise.resolve(buffered.shift());
                    return new Promise((res, rej) => {
                        const timer = setTimeout(() => rej(new Error('timeout waiting for event')), timeoutMs);
                        waiters.push((event) => { clearTimeout(timer); res(event); });
                    });
                },
                async waitFor(predicate, { timeoutMs = 5000, label = 'event' } = {}) {
                    const deadline = Date.now() + timeoutMs;
                    for (;;) {
                        const remaining = deadline - Date.now();
                        if (remaining <= 0) throw new Error(`timeout waiting for ${label}`);
                        const event = await this.nextEvent(remaining);
                        if (predicate(event)) return event;
                    }
                },
                // A test client has no need for a graceful WS close
                // handshake — destroy() forces the TCP connection down
                // immediately so the test server's http.Server.close()
                // (which waits for every tracked connection, including
                // upgraded ones) is never left waiting on a half-closed
                // socket.
                close: () => socket.destroy(),
            });
        });

        req.on('error', reject);
        req.end();
    });
}

module.exports = { connect };
