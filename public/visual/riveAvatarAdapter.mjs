'use strict';

// Runtime layer: applies a normalized AvatarCommand to whatever
// `inputAdapter` it's given (a real Rive state-machine input adapter once
// a .riv exists, or the mock/debug adapter in this same file used by
// public/visual/debug/avatar-debug.mjs today). Ported from
// tools/WineMD-Character-SDK/05_runtime/src/SommelierController.ts's
// SommelierController class — same stale-generationId guard, same
// endGeneration() reset behavior — adapted to the canonical AvatarCommand
// shape (avatarCommandSchema.mjs) instead of the SDK's own SommelierEvent
// type, and to plain JS since this repo has no TypeScript build step (see
// .claude/skills/winemd-rive/references/runtime-integration.md).
//
// No .riv file exists yet — this module has ZERO dependency on any Rive
// package. It only knows about the tiny `{setNumber(name, value),
// fire(name)}` interface; a real Rive adapter and the mock debug adapter
// both satisfy it identically. Importing/using this file must never fail
// just because no .riv exists.

import { assertAvatarCommand, MODES, GESTURES, EMOTIONS } from './avatarCommandSchema.mjs';

const MODE_VALUE = Object.freeze({ idle: 0, listening: 1, thinking: 2, speaking: 3 });
const GESTURE_VALUE = Object.freeze({ none: 0, welcome: 1, present_wine: 2, present_aroma: 3, present_food: 4, point: 5, goodbye: 6 });
const EMOTION_VALUE = Object.freeze({ neutral: 0, warm: 1, delighted: 2, serious: 3 });

/**
 * @typedef {Object} RiveInputAdapter
 * @property {(name: string, value: number) => void} setNumber
 * @property {(name: string) => void} fire
 */

/**
 * Generic avatar-command runtime — same class shape/behavior as the SDK's
 * SommelierController.ts, renamed to reflect that it's not Rive-specific
 * (it works identically against the debug mock adapter).
 */
export class AvatarCommandRuntime {
    /** @param {RiveInputAdapter} inputAdapter */
    constructor(inputAdapter) {
        this.inputAdapter = inputAdapter;
        /** @type {string|null} */
        this.activeGenerationId = null;
    }

    /**
     * Ignores any command whose generationId doesn't match the one
     * currently "claimed" — identical stale-event guard to
     * SommelierController.apply(): the first command for a fresh
     * generation claims the runtime; anything from an older generation
     * after that is silently dropped. Whoever emits commands MUST call
     * endGeneration(id) on cancel/complete to release the claim, or the
     * next turn's commands will be silently ignored too.
     * @param {import('./avatarCommandSchema.mjs').AvatarCommand} command
     */
    apply(command) {
        assertAvatarCommand(command);
        if (this.activeGenerationId && command.generationId !== this.activeGenerationId) return;
        if (this.activeGenerationId === null) this.activeGenerationId = command.generationId;

        this.inputAdapter.setNumber('mode', MODE_VALUE[command.mode]);
        this.inputAdapter.setNumber('gesture', GESTURE_VALUE[command.gesture]);
        this.inputAdapter.setNumber('emotion', EMOTION_VALUE[command.emotion]);
        this.inputAdapter.setNumber('mouth', command.mouth);
        if (command.blink) this.inputAdapter.fire('blink');
    }

    /**
     * Releases the claim on `id` and resets to idle/none/mouth-neutral.
     * A no-op if `id` isn't the currently-active generation (matches
     * SommelierController.ts's endGeneration exactly) — this is what
     * makes interruption safe: cancelling an already-superseded
     * generation must not reset state a NEWER generation already claimed.
     * @param {string} id
     */
    endGeneration(id) {
        if (this.activeGenerationId !== id) return;
        this.inputAdapter.setNumber('mode', MODE_VALUE.idle);
        this.inputAdapter.setNumber('gesture', GESTURE_VALUE.none);
        this.inputAdapter.setNumber('mouth', 0);
        this.activeGenerationId = null;
    }
}

/**
 * Mock/debug input adapter — no Rive dependency at all, just tracks the
 * last value set for each named input plus a fire-count for triggers, and
 * notifies a callback so a UI (public/visual/debug/avatar-debug.mjs) can
 * render it as plain text. This is what proves the contract (schema +
 * semantic adapter + runtime) is stable BEFORE any real .riv exists — the
 * "professional order" requested: contract -> adapter -> tests -> mock
 * runtime -> real .riv -> art polish.
 * @param {(state: object) => void} [onChange]
 * @returns {RiveInputAdapter & { getState: () => object }}
 */
export function createDebugInputAdapter(onChange = () => {}) {
    const numbers = { mode: MODE_VALUE.idle, gesture: GESTURE_VALUE.none, emotion: EMOTION_VALUE.neutral, mouth: 0 };
    const fireCounts = { blink: 0 };

    const REVERSE_MODE = Object.fromEntries(Object.entries(MODE_VALUE).map(([k, v]) => [v, k]));
    const REVERSE_GESTURE = Object.fromEntries(Object.entries(GESTURE_VALUE).map(([k, v]) => [v, k]));
    const REVERSE_EMOTION = Object.fromEntries(Object.entries(EMOTION_VALUE).map(([k, v]) => [v, k]));

    function getState() {
        return {
            mode: REVERSE_MODE[numbers.mode],
            gesture: REVERSE_GESTURE[numbers.gesture],
            emotion: REVERSE_EMOTION[numbers.emotion],
            mouth: numbers.mouth,
            blinkCount: fireCounts.blink,
        };
    }

    return {
        setNumber(name, value) {
            if (!(name in numbers)) throw new TypeError(`debug_input_adapter_unknown_number_input: ${name}`);
            numbers[name] = value;
            onChange(getState());
        },
        fire(name) {
            if (!(name in fireCounts)) throw new TypeError(`debug_input_adapter_unknown_trigger_input: ${name}`);
            fireCounts[name] += 1;
            onChange(getState());
        },
        getState,
    };
}

export { MODE_VALUE, GESTURE_VALUE, EMOTION_VALUE, MODES, GESTURES, EMOTIONS };
