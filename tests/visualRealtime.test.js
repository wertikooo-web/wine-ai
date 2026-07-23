'use strict';

const { startTestServer } = require('./helpers/testServer');
const { connect } = require('./helpers/wsTestClient');
const t = require('./helpers/assertions');

async function startTextTurn(client, text) {
    client.sendJson({ type: 'input_text.submit', text });
    const reset = await client.waitFor((event) => event.type === 'visual.reset' && event.sequence === 1);
    const submitted = await client.waitFor((event) => event.type === 'input_text.submitted');
    return { reset, submitted };
}

async function run() {
    const { port, close } = await startTestServer({
        mockConfig: { processingDelayMs: 25, chunkCount: 10, chunkIntervalMs: 40 },
    });
    try {
        const client = await connect(port);
        await client.waitFor((event) => event.type === 'session.ready');
        client.sendJson({ type: 'session.start', sampleRate: 16000 });
        await client.waitFor((event) => event.type === 'session.config.applied');

        const first = await startTextTurn(client, 'Что посоветуешь к утке?');
        const wine = await client.waitFor((event) => event.type === 'visual.wine.show' && event.generationId === first.submitted.generation_id);
        t.equal(first.reset.protocolVersion, 1);
        t.equal(wine.wineId, 'demo-wine-001');
        t.ok(wine.sequence > first.reset.sequence);

        client.sendJson({ type: 'session.interrupt', reason: 'visual_test_interrupt' });
        const cancelled = await client.waitFor((event) => event.type === 'visual.timeline.cancel' && event.generationId === first.submitted.generation_id);
        t.equal(cancelled.generationId, first.submitted.generation_id);

        const next = await startTextTurn(client, 'А к рыбе?');
        t.ok(next.submitted.generation_id !== first.submitted.generation_id);
        const nextWine = await client.waitFor((event) => event.type === 'visual.wine.show' && event.generationId === next.submitted.generation_id);
        t.equal(nextWine.wineId, 'demo-wine-002');
        client.close();
        return { assertionCount: 6 };
    } finally {
        await close();
    }
}

module.exports = { run };
