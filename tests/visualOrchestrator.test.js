'use strict';

const t = require('./helpers/assertions');
const { createVisualOrchestrator } = require('../src/visual/visualOrchestrator');

function harness() {
    const events = [];
    const logs = [];
    let timerId = 0;
    const timers = new Map();
    const orchestrator = createVisualOrchestrator({
        emit: (event) => { events.push(event); return true; },
        log: (stage, detail) => logs.push({ stage, detail }),
        setTimer: (callback) => {
            const id = ++timerId;
            timers.set(id, callback);
            return id;
        },
        clearTimer: (id) => timers.delete(id),
    });
    return {
        events,
        logs,
        timers,
        orchestrator,
        flushTimers() {
            for (const [id, callback] of [...timers]) {
                timers.delete(id);
                callback();
            }
        },
    };
}

async function run() {
    const full = harness();
    full.orchestrator.beginGeneration({ generationId: 'gen-full', turnId: 'turn-full' });
    full.orchestrator.noteUserText('gen-full', 'Что посоветуешь к утке?');
    full.orchestrator.markThinking('gen-full');
    full.orchestrator.onAudioStart('gen-full');
    full.flushTimers();
    full.orchestrator.onAudioEnd('gen-full');

    const types = full.events.map((event) => event.type);
    for (const required of [
        'visual.reset', 'visual.avatar.state', 'visual.wine.show',
        'visual.aromas.show', 'visual.pairing.show', 'visual.region.show',
        'visual.card.show', 'visual.commerce.show', 'visual.timeline.complete',
    ]) {
        t.ok(types.includes(required), `full visual plan must emit ${required}`);
    }
    t.equal(full.orchestrator.getState().wineId, 'demo-wine-001');
    t.ok(full.logs.some((entry) => entry.stage === 'visual_plan_created'));
    for (let index = 1; index < full.events.length; index += 1) {
        t.equal(full.events[index].sequence, full.events[index - 1].sequence + 1);
    }

    const interrupted = harness();
    interrupted.orchestrator.beginGeneration({ generationId: 'gen-old', turnId: 'turn-old' });
    interrupted.orchestrator.noteUserText('gen-old', 'Расскажи про Fetească Neagră Reserve');
    interrupted.orchestrator.onAudioStart('gen-old');
    t.ok(interrupted.timers.size > 0, 'audio start must schedule later phases');
    interrupted.orchestrator.cancel('gen-old', 'barge_in');
    t.equal(interrupted.timers.size, 0, 'interrupt must clear every pending visual timer');
    interrupted.flushTimers();
    t.ok(!interrupted.events.some((event) => event.type === 'visual.aromas.show'));
    t.ok(interrupted.events.some((event) => event.type === 'visual.timeline.cancel'));

    const unavailable = harness();
    unavailable.orchestrator.beginGeneration({
        generationId: 'gen-no-commerce',
        turnId: 'turn-no-commerce',
        inputText: 'Хочу белое Viorica',
    });
    unavailable.orchestrator.onAudioStart('gen-no-commerce');
    unavailable.orchestrator.onAudioEnd('gen-no-commerce');
    t.equal(unavailable.orchestrator.getState().wineId, 'demo-wine-003');
    t.ok(!unavailable.events.some((event) => event.type === 'visual.commerce.show'), 'CTA must stay hidden without a valid order URL');

    return { assertionCount: 25 };
}

module.exports = { run };
