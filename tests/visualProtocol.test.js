'use strict';

const assert = require('assert');
const t = require('./helpers/assertions');
const {
    PROTOCOL_VERSION,
    createVisualEvent,
    assertVisualEvent,
} = require('../src/visual/visualProtocol');

async function run() {
    const event = createVisualEvent({
        type: 'visual.wine.show',
        generationId: 'generation-1',
        sequence: 1,
        wineId: 'demo-wine-001',
    });
    t.equal(event.protocolVersion, PROTOCOL_VERSION);
    t.equal(event.wineId, 'demo-wine-001');
    t.ok(Object.isFrozen(event), 'validated visual events must be immutable');

    assert.throws(() => createVisualEvent({
        type: 'visual.unknown',
        generationId: 'generation-1',
        sequence: 2,
    }), /visual_event_type_invalid/);
    assert.throws(() => assertVisualEvent({
        type: 'visual.card.show',
        protocolVersion: 1,
        generationId: 'generation-1',
        sequence: 2,
        html: '<script>bad()</script>',
    }), /visual_html_forbidden/);
    assert.throws(() => createVisualEvent({
        type: 'visual.reset',
        generationId: '../unsafe',
        sequence: 1,
    }), /visual_generation_id_invalid/);
    return { assertionCount: 7 };
}

module.exports = { run };
