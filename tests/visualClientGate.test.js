'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const t = require('./helpers/assertions');

async function run() {
    const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'public', 'visual', 'VisualStoryController.mjs')).href;
    const { VisualEventGate } = await import(moduleUrl);
    const gate = new VisualEventGate();
    const event = (generationId, sequence, type = 'visual.avatar.state') => ({
        type,
        protocolVersion: 1,
        generationId,
        sequence,
    });

    t.ok(gate.accept(event('gen-1', 1, 'visual.reset')).accepted);
    t.ok(gate.accept(event('gen-1', 2)).accepted);
    t.equal(gate.accept(event('gen-1', 2)).reason, 'duplicate_or_out_of_order');
    t.equal(gate.accept(event('gen-old', 7)).reason, 'stale_generation');
    t.ok(gate.accept(event('gen-2', 1, 'visual.reset')).accepted);
    t.equal(gate.accept(event('gen-1', 3)).reason, 'stale_generation');
    t.ok(gate.accept(event('gen-2', 2, 'visual.timeline.cancel')).accepted);
    t.equal(gate.accept(event('gen-2', 3)).reason, 'cancelled_generation');
    t.equal(gate.accept({ ...event('gen-3', 1, 'visual.reset'), protocolVersion: 99 }).reason, 'invalid_protocol');
    return { assertionCount: 9 };
}

module.exports = { run };
