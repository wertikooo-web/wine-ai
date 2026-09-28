'use strict';

// Regression for the production incident (2026-09-28, Grok, tap_to_start):
// search_wine_knowledge with web grounding took 5-8s, the 4.5s no-response
// watchdog (ptt_turn_timeout) fired mid-tool, failed the turn and rotated the
// provider, so the answer never played ("отвечает медленно / не отвечает").
//
// Contract now: while a tool runs, the watchdog window is extended
// (PTT_TOOL_TURN_TIMEOUT_MS); once the tool result is back the ordinary
// window (PTT_TURN_TIMEOUT_MS) re-arms. A tool that never returns still
// times out, so the stuck-turn safety net is preserved.

process.env.NO_SPEECH_MIN_LOUD_MS = '0';

const http = require('http');
const { attachRealtimeServer } = require('../src/realtime/realtimeServer');
const { MockRealtimeProvider, DEFAULT_CONFIG } = require('../src/realtime/mockRealtimeProvider');
const { connect } = require('./helpers/wsTestClient');
const t = require('./helpers/assertions');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Mock provider whose turn starts with a tool call lasting `toolMs`, the way
// the Grok/Gemini adapters emit tool.call -> (handler runs) -> tool.response.
function start({ toolMs, toolNeverReturns = false }) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => res.end());
        const mock = new MockRealtimeProvider({ ...DEFAULT_CONFIG, processingDelayMs: 50, chunkCount: 2, chunkIntervalMs: 20 });
        attachRealtimeServer(server, {
            providerFactory: (options) => {
                const session = mock.createSession(options);
                const originalEndInput = session.endInput.bind(session);
                session.endInput = async (context) => {
                    context.onEvent({ type: 'tool.call', tool_name: 'search_wine_knowledge', provider_instance_id: session.instanceId });
                    if (toolNeverReturns) return;
                    await sleep(toolMs);
                    if (context.signal.cancelled) return;
                    context.onEvent({ type: 'tool.response', tool_names: ['search_wine_knowledge'], provider_instance_id: session.instanceId });
                    return originalEndInput(context);
                };
                return session;
            },
            providerMetadata: { provider: 'mock', model: 'mock', contentToolsEnabled: false },
        });
        server.listen(0, () => resolve({
            port: server.address().port,
            close: () => { server.closeAllConnections?.(); server.close(); },
        }));
    });
}

async function runTurn(port) {
    const client = await connect(port);
    const events = [];
    try {
        await client.waitFor((e) => e.type === 'session.ready');
        client.sendJson({ type: 'session.start', sampleRate: 16000 });
        await client.waitFor((e) => e.type === 'session.config.applied');
        client.sendJson({ type: 'input_audio.start', mode: 'push_to_talk' });
        await client.waitFor((e) => e.type === 'input_audio.start');
        client.sendBinary(Buffer.alloc(3200));
        client.sendJson({ type: 'input_audio.end' });
        const deadline = Date.now() + 6000;
        for (;;) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            let event;
            try { event = await client.nextEvent(remaining); } catch { break; }
            events.push(event);
            if (event.type === 'audio.end' || event.type === 'response.failed') break;
        }
        return events;
    } finally {
        client.close();
    }
}

async function run() {
    process.env.PTT_TURN_TIMEOUT_MS = '400';
    process.env.PTT_TOOL_TURN_TIMEOUT_MS = '3000';
    try {
        // 1. Tool takes 3x longer than the ordinary window: the answer must play.
        {
            const server = await start({ toolMs: 1200 });
            try {
                const events = await runTurn(server.port);
                const failed = events.find((e) => e.type === 'response.failed');
                t.ok(!failed, `turn must not fail while a tool is running (got ${failed && failed.reason})`);
                t.ok(events.some((e) => e.type === 'audio.chunk'), 'answer audio is delivered after the tool returns');
                t.ok(events.some((e) => e.type === 'audio.end'), 'turn completes normally');
            } finally {
                server.close();
            }
        }

        // 2. Tool never returns: the stuck-turn safety net still fires, after
        //    the extended tool window (not the short one).
        {
            process.env.PTT_TOOL_TURN_TIMEOUT_MS = '900';
            const server = await start({ toolNeverReturns: true });
            try {
                const startedAt = Date.now();
                const events = await runTurn(server.port);
                const failed = events.find((e) => e.type === 'response.failed');
                t.ok(failed, 'a hung tool still ends in response.failed');
                t.equal(failed.reason, 'provider_timeout', 'failure reason is the watchdog timeout');
                t.equal(failed.timeout_ms, 900, 'timeout uses the extended tool window');
                t.ok(Date.now() - startedAt >= 850, 'watchdog did not fire at the short 400ms window');
            } finally {
                server.close();
            }
        }
    } finally {
        delete process.env.PTT_TURN_TIMEOUT_MS;
        delete process.env.PTT_TOOL_TURN_TIMEOUT_MS;
    }
}

module.exports = { run };
