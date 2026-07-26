'use strict';

// Regression coverage for the "provider interrupted event dropped" bug:
// production logs showed Gemini's serverContent.interrupted (which never
// carries a generation id of its own) arriving while a generation WAS
// active, but getting logged+dropped as reason=unmatched_provider_interrupt
// because handleProviderInterrupted() only trusted `pendingInterrupt`,
// which is only set when OUR OWN code explicitly called interrupt() first —
// not set for a turn transition where cancelCurrent() already saw the prior
// generation as completed and no-opped. See src/realtime/geminiLiveProvider.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { GeminiLiveProvider } = require('../src/realtime/geminiLiveProvider');

function makeSession(overrides = {}) {
    const provider = new GeminiLiveProvider({ apiKey: 'unused-in-this-test' });
    const providerEvents = [];
    const session = provider.createSession({
        voiceMode: 'tap_to_start',
        systemInstructionText: 'x',
        onProviderEvent: (event) => providerEvents.push(event),
        ...overrides,
    });
    return { session, providerEvents };
}

test('provider-emitted interrupted event with no generation id falls back to the current active generation and is not dropped', () => {
    const { session } = makeSession();
    const sessionEvents = [];
    const droppedLogs = [];
    // Simulate an active generation the SAME way beginResponse() would set
    // one up, without going through beginResponse()'s real connect() side
    // effects (this test is about handleProviderInterrupted()'s state
    // reading, not the network layer).
    session.active = {
        generationId: 'generation_active_123',
        responseId: 'response_active_123',
        turnId: 'turn_active_123',
        onSessionEvent: (event) => sessionEvents.push(event),
        log: (stage, data) => { if (stage === 'dropped_provider_event') droppedLogs.push(data); },
    };
    // No pendingInterrupt was ever set -- this is exactly the case where our
    // own cancelCurrent() no-opped (prior generation already completed) but
    // Gemini itself still reports interrupted for its own reasons.
    assert.equal(session.pendingInterrupt, null);

    // Gemini's real wire shape: a bare boolean, no generation id anywhere.
    session.handleMessage({ serverContent: { interrupted: true } });

    assert.deepEqual(droppedLogs, [], 'the event must not be dropped when an active generation exists');

    const normalized = sessionEvents.find((e) => e.type === 'response.interrupted');
    assert.ok(normalized, 'client must receive a normalized response.interrupted event');
    assert.equal(normalized.generation_id, 'generation_active_123', 'falls back to the current active generation id');
    assert.equal(normalized.reason, 'provider_interrupted');
});

test('the durable session-level sink (onProviderEvent) is used whenever no per-turn active/pendingInterrupt onSessionEvent is available', () => {
    const { session, providerEvents } = makeSession();
    // No this.active, but a pendingInterrupt snapshot whose own
    // onSessionEvent was never captured (simulates an interrupt() call made
    // before any turn had set onSessionEvent) -- emit must still fall all
    // the way through to this.onProviderEvent rather than silently doing
    // nothing.
    session.pendingInterrupt = {
        interrupted_generation_id: 'generation_from_pending_only',
        interrupted_turn_id: 'turn_x',
        interrupted_response_id: 'response_x',
        provider_instance_id: session.instanceId,
        interrupt_requested_at: Date.now(),
        onSessionEvent: null,
        log: () => {},
    };

    session.handleMessage({ serverContent: { interrupted: true } });

    const normalized = providerEvents.find((e) => e.type === 'response.interrupted');
    assert.ok(normalized, 'must reach the client via the durable session-level sink');
    assert.equal(normalized.generation_id, 'generation_from_pending_only');
});

test('a genuinely unattributable interrupted event (no active generation, no pending interrupt) is still correctly dropped', () => {
    const { session, providerEvents } = makeSession();
    // this.active is null (generation already fully finished and cleared)
    // AND no pendingInterrupt exists -- there is truly nothing to attribute
    // this event to, so it must still be dropped rather than fabricating a
    // generation id from nothing.
    assert.equal(session.active, null);
    assert.equal(session.pendingInterrupt, null);

    session.handleMessage({ serverContent: { interrupted: true } });

    assert.equal(providerEvents.length, 0, 'with truly no generation context (no active, no pending interrupt), there is nothing to attribute this to -- correctly dropped, not fabricated');
});

test('an explicitly-requested interrupt still matches and acknowledges as before (no regression)', () => {
    const { session } = makeSession();
    const sessionEvents = [];
    session.active = {
        generationId: 'generation_will_be_interrupted',
        responseId: 'response_will_be_interrupted',
        turnId: 'turn_will_be_interrupted',
        onSessionEvent: (event) => sessionEvents.push(event),
        log: () => {},
        signal: { cancelled: false },
    };
    // interrupt() captures this.active's onSessionEvent into the
    // pendingInterrupt snapshot BEFORE clearing this.active to null -- so
    // once handleMessage() runs (with this.active already null again, as it
    // would be after a real client-initiated interrupt), the emit fallback
    // resolves to that snapshot, not the durable session-level sink.
    session.interrupt('client_interrupt', {
        interrupted_generation_id: 'generation_will_be_interrupted',
        interrupted_turn_id: 'turn_will_be_interrupted',
        interrupted_response_id: 'response_will_be_interrupted',
    });
    assert.ok(session.pendingInterrupt, 'interrupt() must record a pendingInterrupt snapshot');
    assert.equal(session.active, null, 'interrupt() clears the per-turn active context');

    session.handleMessage({ serverContent: { interrupted: true } });

    const normalized = sessionEvents.find((e) => e.type === 'response.interrupted');
    assert.ok(normalized);
    assert.equal(normalized.generation_id, 'generation_will_be_interrupted');
    const ack = sessionEvents.find((e) => e.type === 'provider_interrupt_ack');
    assert.ok(ack, 'the matched-interrupt ack path must still fire');
    assert.equal(session.pendingInterrupt, null, 'pendingInterrupt must be cleared after handling');
});
