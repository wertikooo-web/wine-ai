'use strict';

const PROTOCOL_VERSION = 1;
const VISUAL_EVENT_TYPES = new Set([
    'visual.reset',
    'visual.avatar.state',
    'visual.wine.show',
    'visual.wine.hide',
    'visual.aromas.show',
    'visual.pairing.show',
    'visual.region.show',
    'visual.card.show',
    'visual.commerce.show',
    'visual.timeline.complete',
    'visual.timeline.cancel',
]);
const AVATAR_STATES = new Set([
    'idle', 'greeting', 'listening', 'thinking', 'speaking',
    'enthusiastic', 'presenting_wine', 'pointing', 'confirming_order', 'goodbye',
]);

function isSafeIdentifier(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
}

function assertVisualEvent(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new TypeError('visual_event_must_be_object');
    }
    if (!VISUAL_EVENT_TYPES.has(event.type)) throw new TypeError('visual_event_type_invalid');
    if (event.protocolVersion !== PROTOCOL_VERSION) throw new TypeError('visual_protocol_version_invalid');
    if (!isSafeIdentifier(event.generationId)) throw new TypeError('visual_generation_id_invalid');
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new TypeError('visual_sequence_invalid');
    if ('html' in event) throw new TypeError('visual_html_forbidden');
    return event;
}

function createVisualEvent({ type, generationId, sequence, ...payload }) {
    return Object.freeze(assertVisualEvent({
        type,
        protocolVersion: PROTOCOL_VERSION,
        generationId,
        sequence,
        ...payload,
    }));
}

module.exports = {
    PROTOCOL_VERSION,
    VISUAL_EVENT_TYPES,
    AVATAR_STATES,
    createVisualEvent,
    assertVisualEvent,
    isSafeIdentifier,
};
