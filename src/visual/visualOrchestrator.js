'use strict';

const { AVATAR_STATES, createVisualEvent } = require('./visualProtocol');
const { chooseWineId, getValidatedPresentation } = require('./visualCatalog');

const PHASE_DELAYS_MS = Object.freeze({
    AROMAS: 850,
    PAIRING: 1750,
    REGION: 2500,
    SUMMARY: 3250,
    COMMERCE: 4050,
});

function createVisualOrchestrator({ emit, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (typeof emit !== 'function') throw new TypeError('visual_emit_required');
    let active = null;

    function isActive(generationId) {
        return Boolean(active && !active.cancelled && active.generationId === generationId);
    }

    function emitEvent(type, payload = {}) {
        if (!active) return false;
        const event = createVisualEvent({
            type,
            generationId: active.generationId,
            sequence: ++active.sequence,
            ...payload,
        });
        const sent = emit(event);
        log('visual_event_sent', {
            generationId: active.generationId,
            sequence: event.sequence,
            eventType: event.type,
            sent,
        });
        return sent;
    }

    function clearTimers() {
        if (!active) return;
        for (const timer of active.timers) clearTimer(timer);
        active.timers.clear();
    }

    function avatarState(state, parameters = {}) {
        if (!AVATAR_STATES.has(state)) return false;
        return emitEvent('visual.avatar.state', {
            state,
            speechAmplitude: Number(parameters.speechAmplitude || 0),
            mouthOpen: Number(parameters.mouthOpen || 0),
            emotion: String(parameters.emotion || 'neutral'),
            gesture: String(parameters.gesture || 'none'),
            intensity: Number(parameters.intensity || 0.5),
        });
    }

    function cancel(generationId, reason = 'cancelled') {
        if (!isActive(generationId)) return false;
        clearTimers();
        emitEvent('visual.timeline.cancel', { reason: String(reason).slice(0, 80) });
        emitEvent('visual.reset', { transition: 'soft', reason: 'generation_cancelled' });
        active.cancelled = true;
        log('visual_generation_cancelled', { generationId, reason });
        return true;
    }

    function beginGeneration({ generationId, turnId, inputText = '' }) {
        if (active && !active.cancelled && active.generationId !== generationId) {
            cancel(active.generationId, 'superseded');
        }
        active = {
            generationId,
            turnId,
            inputText: String(inputText || ''),
            sequence: 0,
            timers: new Set(),
            cancelled: false,
            completed: false,
            plan: null,
            emittedPhases: new Set(),
        };
        emitEvent('visual.reset', { transition: 'soft', reason: 'new_generation' });
        avatarState('listening', { emotion: 'attentive', intensity: 0.55 });
        return generationId;
    }

    function noteUserText(generationId, text) {
        if (!isActive(generationId)) return false;
        active.inputText += ` ${String(text || '')}`;
        return true;
    }

    function markThinking(generationId) {
        if (!isActive(generationId)) return false;
        return avatarState('thinking', { emotion: 'focused', intensity: 0.6 });
    }

    function createPlan(generationId) {
        if (!isActive(generationId)) return null;
        const wineId = chooseWineId(active.inputText);
        const presentation = getValidatedPresentation(wineId) || getValidatedPresentation('demo-wine-001');
        if (!presentation) return null;
        active.plan = presentation;
        log('visual_plan_created', {
            generationId,
            turnId: active.turnId,
            wineId: presentation.knowledge.wineId,
            phases: 'INTRO,WINE_REVEAL,AROMAS,PAIRING,REGION,SUMMARY,COMMERCE',
        });
        return presentation;
    }

    function runPhase(generationId, phase) {
        if (!isActive(generationId) || !active.plan || active.emittedPhases.has(phase)) return false;
        active.emittedPhases.add(phase);
        const { knowledge, commerce, assetSet, assetSetId, aromas, pairings, region } = active.plan;
        if (phase === 'WINE_REVEAL') {
            avatarState('presenting_wine', { emotion: 'enthusiastic', gesture: 'present_wine', intensity: 0.75 });
            return emitEvent('visual.wine.show', {
                wineId: knowledge.wineId,
                presentation: 'hero',
                assetSetId,
                asset: assetSet,
                label: { name: knowledge.name, winery: knowledge.winery, vintage: knowledge.vintage },
            });
        }
        if (phase === 'AROMAS') {
            return emitEvent('visual.aromas.show', { wineId: knowledge.wineId, descriptors: aromas });
        }
        if (phase === 'PAIRING') {
            avatarState('pointing', { emotion: 'warm', gesture: 'present_pairing', intensity: 0.7 });
            return emitEvent('visual.pairing.show', { wineId: knowledge.wineId, pairings });
        }
        if (phase === 'REGION' && region) {
            return emitEvent('visual.region.show', { wineId: knowledge.wineId, region });
        }
        if (phase === 'SUMMARY') {
            return emitEvent('visual.card.show', {
                wineId: knowledge.wineId,
                card: {
                    name: knowledge.name,
                    winery: knowledge.winery,
                    vintage: knowledge.vintage,
                    region: knowledge.region,
                    grapes: knowledge.grapes,
                    servingTemperature: knowledge.servingTemperature,
                    alcohol: knowledge.alcohol,
                    shortDescription: knowledge.shortDescription,
                },
            });
        }
        if (phase === 'COMMERCE' && commerce && commerce.orderUrl && commerce.availability === 'demo_available') {
            avatarState('confirming_order', { emotion: 'helpful', gesture: 'present_cta', intensity: 0.65 });
            return emitEvent('visual.commerce.show', {
                wineId: knowledge.wineId,
                commerce: {
                    productId: commerce.productId,
                    orderUrl: commerce.orderUrl,
                    qrUrl: commerce.qrUrl,
                    availability: commerce.availability,
                    price: commerce.price,
                    currency: commerce.currency,
                },
            });
        }
        return false;
    }

    function schedulePhase(generationId, phase, delayMs) {
        const timer = setTimer(() => {
            if (active) active.timers.delete(timer);
            runPhase(generationId, phase);
        }, delayMs);
        active.timers.add(timer);
    }

    function onAudioStart(generationId) {
        if (!isActive(generationId)) return false;
        if (!active.plan && !createPlan(generationId)) return false;
        avatarState('speaking', { emotion: 'warm', intensity: 0.65 });
        runPhase(generationId, 'WINE_REVEAL');
        for (const [phase, delay] of Object.entries(PHASE_DELAYS_MS)) {
            schedulePhase(generationId, phase, delay);
        }
        return true;
    }

    function onAudioEnd(generationId) {
        if (!isActive(generationId)) return false;
        clearTimers();
        for (const phase of ['AROMAS', 'PAIRING', 'REGION', 'SUMMARY', 'COMMERCE']) {
            runPhase(generationId, phase);
        }
        avatarState('idle', { emotion: 'satisfied', intensity: 0.4 });
        emitEvent('visual.timeline.complete', {
            wineId: active.plan?.knowledge?.wineId || null,
            keepFinalCard: true,
        });
        active.completed = true;
        return true;
    }

    function getState() {
        if (!active) return null;
        return {
            generationId: active.generationId,
            sequence: active.sequence,
            cancelled: active.cancelled,
            completed: active.completed,
            wineId: active.plan?.knowledge?.wineId || null,
            pendingTimers: active.timers.size,
        };
    }

    return {
        beginGeneration,
        noteUserText,
        markThinking,
        onAudioStart,
        onAudioEnd,
        cancel,
        getState,
    };
}

module.exports = { PHASE_DELAYS_MS, createVisualOrchestrator };
