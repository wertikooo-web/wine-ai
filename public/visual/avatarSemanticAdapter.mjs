'use strict';

// Translates the REAL visual.* event stream (src/visual/visualProtocol.js,
// src/visual/visualOrchestrator.js) into the canonical AvatarCommand shape
// (avatarCommandSchema.mjs). This is the "avatar semantic adapter" layer:
//
//   existing visual protocol -> avatar semantic adapter -> normalized avatar command -> Rive runtime adapter
//
// Every mapping decision below is either (a) a direct, evidenced
// translation of a state/gesture/emotion string the real orchestrator
// ACTUALLY emits today, or (b) an explicitly labeled fallback/unsupported
// case for a value that's declared valid but never emitted, or has no
// SDK-side equivalent. Nothing here invents new visual behavior — see
// .claude/skills/winemd-rive/references/state-machine-contract.md and
// troubleshooting.md for the full analysis this table is derived from.
//
// Verified against src/visual/visualOrchestrator.js on 2026-07-25 — the
// ONLY avatarState() calls that exist are:
//   beginGeneration   -> ('listening', {emotion:'attentive', intensity:0.55})
//   markThinking      -> ('thinking',  {emotion:'focused',   intensity:0.6})
//   onAudioStart      -> ('speaking',  {emotion:'warm',       intensity:0.65})
//   runPhase(WINE_REVEAL)  -> ('presenting_wine', {emotion:'enthusiastic', gesture:'present_wine',    intensity:0.75})
//   runPhase(PAIRING)      -> ('pointing',         {emotion:'warm',        gesture:'present_pairing', intensity:0.7})
//   runPhase(COMMERCE)     -> ('confirming_order', {emotion:'helpful',     gesture:'present_cta',     intensity:0.65})
//   onAudioEnd        -> ('idle', {emotion:'satisfied', intensity:0.4})
// 'greeting', 'enthusiastic' (as a top-level state), and 'goodbye' are
// declared in AVATAR_STATES but never actually emitted by any code path.
// runPhase('AROMAS') emits visual.aromas.show but calls NO avatarState() —
// there is currently no gesture signal at all for the aroma reveal.

import { createAvatarCommand } from './avatarCommandSchema.mjs';

/**
 * Real AVATAR_STATES -> normalized {mode, gesture}. Every entry is tagged
 * with how confident/evidenced it is — read the `kind` field before
 * trusting an entry blindly:
 *   'mapped'      — direct translation of a state the orchestrator actually emits.
 *   'fallback'    — declared-valid state, never observed emitted; falls back
 *                   to a safe default (idle/none) rather than guessing new behavior.
 *   'unsupported' — no equivalent exists in the SDK's SommelierGesture/mode
 *                   vocabulary at all; falls back, and is logged distinctly
 *                   so it's never silently confused with a confident mapping.
 */
export const STATE_MAP = Object.freeze({
    idle:              { kind: 'mapped',       mode: 'idle',      gesture: 'none' },
    listening:         { kind: 'mapped',       mode: 'listening', gesture: 'none' },
    thinking:          { kind: 'mapped',       mode: 'thinking',  gesture: 'none' },
    speaking:          { kind: 'mapped',       mode: 'speaking',  gesture: 'none' },
    presenting_wine:   { kind: 'mapped',       mode: 'speaking',  gesture: 'present_wine' },
    // 'pointing' is a GENERIC gesture in the real orchestrator — its only
    // caller today happens to be runPhase('PAIRING'), but the state name
    // itself carries no food/pairing semantics. Mapping it to present_food
    // would tie a generic gesture to business meaning just because of who
    // currently calls it. Maps to the generic 'point' gesture instead;
    // present_food stays a distinct, reserved command for when the
    // orchestrator starts emitting an explicit pairing/food event.
    pointing:          { kind: 'mapped',       mode: 'speaking',  gesture: 'point' },
    // 'confirming_order' has NO equivalent gesture in GESTURES at all
    // (none of welcome/present_wine/present_aroma/present_food/goodbye
    // fits "confirm this order") — mode mapping to 'speaking' matches the
    // existing precedent in public/visual/VisualStoryController.mjs's
    // setAvatarState() (groups speaking/enthusiastic/presenting_wine/
    // pointing/confirming_order all under its own "speaking" device state).
    confirming_order:  { kind: 'unsupported',  mode: 'speaking',  gesture: 'none' },
    // Declared in AVATAR_STATES, never emitted by any current code path.
    greeting:          { kind: 'fallback',     mode: 'idle',      gesture: 'welcome' },
    enthusiastic:      { kind: 'fallback',     mode: 'speaking',  gesture: 'none' },
    goodbye:           { kind: 'fallback',     mode: 'idle',      gesture: 'goodbye' },
});

/**
 * Real (free-form) emotion strings the orchestrator emits -> SDK
 * SommelierEmotion. None of these are exact-name matches except 'warm' —
 * every other one is an editorial nearest-fit, listed explicitly so it can
 * be revisited rather than hidden inside opaque logic.
 */
export const EMOTION_MAP = Object.freeze({
    attentive:    'neutral',   // no close match; neutral is the safe default
    focused:      'serious',   // nearest fit — "concentrating"
    warm:         'warm',      // exact match
    enthusiastic: 'delighted', // nearest fit — high positive energy
    helpful:      'neutral',   // no close match
    satisfied:    'delighted', // nearest fit — positive, calm resolution
});

const DEFAULT_EMOTION = 'neutral';

/**
 * visual.avatar.state's mouthOpen is a continuous 0..1 amplitude (see
 * VisualStoryController.mjs's --mouth-open CSS variable, driven by a Web
 * Audio AnalyserNode) — NOT the discrete 0-4 mouth enum SommelierEvent
 * expects. tools/WineMD-Character-SDK/02_psd_spec/MOUTH_AND_EYES.md
 * explicitly scopes MVP to neutral/A/M-B-P only ("audio amplitude may
 * switch between neutral, A and M-B-P"), so this is a 2-threshold
 * classifier, not real viseme detection. Thresholds are a reasonable
 * starting guess, NOT tuned against real audio — revisit once there's a
 * real .riv to actually look at.
 */
export function amplitudeToMouth(mouthOpen) {
    const amplitude = Number(mouthOpen) || 0;
    if (amplitude <= 0.15) return 0; // neutral
    if (amplitude <= 0.6) return 1;  // A
    return 4;                        // M-B-P
}

/**
 * Blink is NEVER present on any real visual.* event — src/visual/
 * visualOrchestrator.js has no blink concept at all. Per
 * tools/WineMD-Character-SDK/04_animation_library/ANIMATIONS.md, "Idle"
 * already specifies "random blink" as an autonomous idle-loop behavior,
 * not something server-driven. This adapter therefore NEVER sets
 * blink: true — that's a deliberate, evidenced omission, not an
 * oversight. A runtime adapter (riveAvatarAdapter.mjs) may run its own
 * local timer for autonomous blinking while mode === 'idle'; that's a
 * runtime-layer concern, not a semantic-adapter one.
 */
const BLINK_ALWAYS_FALSE = false;

/**
 * @param {object} log optional logger, e.g. (event, data) => void
 */
export function createAvatarSemanticAdapter({ log = () => {} } = {}) {
    /**
     * Translates one visual.* event into a normalized AvatarCommand, or
     * returns null if the event type carries no avatar-command-relevant
     * information (e.g. visual.wine.show only affects card UI, not the
     * character itself).
     * @param {object} event a real event from src/visual/visualProtocol.js
     * @returns {import('./avatarCommandSchema.mjs').AvatarCommand | null}
     */
    function translate(event) {
        if (!event || event.type !== 'visual.avatar.state') return null;

        const stateEntry = STATE_MAP[event.state];
        if (!stateEntry) {
            log('avatar_semantic_adapter_unknown_state', { state: event.state, generationId: event.generationId });
            return createAvatarCommand({ generationId: event.generationId, mode: 'idle', gesture: 'none', emotion: DEFAULT_EMOTION, mouth: 0, blink: BLINK_ALWAYS_FALSE });
        }
        if (stateEntry.kind !== 'mapped') {
            log('avatar_semantic_adapter_' + stateEntry.kind + '_state', { state: event.state, generationId: event.generationId });
        }

        const emotion = EMOTION_MAP[event.emotion] || DEFAULT_EMOTION;
        const mouth = amplitudeToMouth(event.mouthOpen);

        return createAvatarCommand({
            generationId: event.generationId,
            mode: stateEntry.mode,
            gesture: stateEntry.gesture,
            emotion,
            mouth,
            blink: BLINK_ALWAYS_FALSE,
        });
    }

    return { translate };
}
