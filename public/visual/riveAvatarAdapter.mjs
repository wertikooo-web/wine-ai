'use strict';

// Runtime layer: applies a normalized AvatarCommand as one atomic snapshot
// to whatever `inputAdapter` it's given (a real Rive state-machine input
// adapter once a .riv exists, or the mock/debug adapter in this same file
// used by public/visual/debug/avatar-debug.mjs today). Ported from
// tools/WineMD-Character-SDK/05_runtime/src/SommelierController.ts's
// SommelierController class -- same stale-generationId guard, same
// endGeneration() reset behavior -- adapted to the canonical AvatarCommand
// shape (avatarCommandSchema.mjs) instead of the SDK's own SommelierEvent
// type, and to plain JS since this repo has no TypeScript build step (see
// .claude/skills/winemd-rive/references/runtime-integration.md).
//
// No .riv file exists yet -- this module has ZERO dependency on any Rive
// package. It only knows about the RiveInputAdapter contract below; a real
// Rive adapter and the mock debug adapter both satisfy it identically.
// Importing/using this file must never fail just because no .riv exists.
//
// RiveInputAdapter contract (fixed 2026-07-25, post interface-boundary
// audit -- full rationale in
// .claude/skills/winemd-rive/references/state-machine-contract.md's
// "RiveInputAdapter interface" section):
//
//   - applySnapshot({mode, gesture, emotion, mouth}): applies all four
//     state-machine inputs as ONE atomic call. Replaces the previous four
//     separate setNumber() calls so a real state machine can never observe
//     a partially-updated combination (e.g. new mode with stale gesture)
//     between two of them. Values are the same semantic strings/numbers
//     AvatarCommand carries (e.g. mode: 'speaking', gesture: 'point') --
//     NOT pre-converted to Rive's numeric enum values. Converting semantic
//     names to whatever a specific engine needs (Rive's numeric state
//     machine inputs, or anything else) is that adapter's own concern, not
//     this generic runtime's -- this keeps AvatarCommandRuntime itself
//     vendor-neutral; RiveInputAdapter is deliberately the one place that
//     IS allowed to know about Rive specifically (see decision record
//     below).
//   - fireTrigger(name): fires a one-shot trigger input (e.g. "blink").
//     Kept separate from applySnapshot because triggers are momentary
//     events, not persistent state.
//   - dispose(): releases the adapter. This lifecycle contract is MANDATORY
//     for every RiveInputAdapter implementation -- mock and production MUST
//     NOT have different lifecycle semantics:
//       * dispose() MUST be idempotent -- a second (or later) call MUST NOT
//         throw.
//       * applySnapshot() called after dispose() MUST throw a clear
//         lifecycle error.
//       * fireTrigger() called after dispose() MUST throw a clear
//         lifecycle error.
//     Rationale: silently swallowing calls into a disposed adapter would
//     hide real bugs (e.g. a caller that forgot to stop sending commands
//     after teardown) -- fail-fast is required everywhere this interface
//     is implemented, not just in the debug/mock adapter below.
//   - getState(): DEBUG/MOCK-ONLY. Not part of the RiveInputAdapter
//     contract itself -- only createDebugInputAdapter() below exposes it,
//     for the debug harness to render plain-text state. A production Rive
//     adapter is not required to implement it.
//
// Naming decision: this interface stays named RiveInputAdapter (not
// renamed to something vendor-neutral) precisely BECAUSE it is the lower
// boundary specifically with Rive -- the vendor-neutral contract already
// lives one layer up, in AvatarCommand (avatarCommandSchema.mjs) and
// AvatarCommandRuntime (this file). Swapping animation engines later means
// writing a new adapter satisfying this same shape, not renaming it.
//
// Async factory contract (NOT implemented here -- no Rive SDK dependency
// exists in this repo yet; this is documentation only, mirrored in
// state-machine-contract.md):
//
//   async function createRiveInputAdapter(options) -> Promise<RiveInputAdapter>
//
//   - Loading Rive (WASM + fetching the .riv file + validating the state
//     machine's inputs) is inherently asynchronous, so adapter creation
//     MUST be an async factory, not a synchronous constructor.
//   - AvatarCommandRuntime is constructed ONLY with an ALREADY-INITIALIZED
//     adapter -- i.e. only after `await createRiveInputAdapter(options)`
//     resolves. AvatarCommandRuntime itself has no isReady()/onReady() and
//     does no buffering of pre-ready commands, BY DESIGN -- readiness is
//     entirely the factory's responsibility, not the runtime's.
//   - During initialization, the factory MUST verify every state-machine
//     input this contract requires (mode, gesture, emotion, mouth, blink)
//     actually exists on the loaded state machine.
//   - If any required input is missing, the factory MUST reject with an
//     Error whose message names the missing input, e.g.
//     `new Error('rive_input_adapter_missing_required_input: gesture')` --
//     never silently ignore a missing required input.
//   - Once the returned Promise resolves, applySnapshot()/fireTrigger()
//     MUST NOT re-resolve/look up inputs by name again -- name-to-input
//     resolution happens once, during init, and is cached internally by
//     the adapter, not repeated on every call.
//
// Deliberately NOT part of this contract (see the interface audit for
// rationale) -- do not add these without a fresh review: callbacks from
// Rive, subscribe/onEvent, gesture-complete events, runtime capability
// negotiation, pause/resume, attachCanvas/detachCanvas, an adapter
// registry, or support for other animation engines.
//
// Decision record -- visual.timeline.complete does NOT call endGeneration()
// (Avatar Contract v1, fixed 2026-07-25): when a generation finishes
// normally, this runtime deliberately leaves that generation's claim in
// place and the avatar in whatever idle snapshot the orchestrator's own
// onAudioEnd() -> avatarState('idle', ...) already produced. The claim is
// released only by an explicit reset/cancel (visual.reset /
// visual.timeline.cancel, both routed through endGeneration() by any
// consumer, e.g. avatar-debug.mjs) or by the next generation's first
// command superseding it. This is intentional, documented v1 behavior, NOT
// an unfixed bug -- see the contract review this decision came from for
// the full reasoning (a future ambient/idle-driven command source calling
// apply() between turns would need this revisited, but no such source
// exists yet).

import { assertAvatarCommand } from './avatarCommandSchema.mjs';

/**
 * @typedef {Object} AvatarSnapshot
 * @property {'idle'|'listening'|'thinking'|'speaking'} mode
 * @property {'none'|'welcome'|'present_wine'|'present_aroma'|'present_food'|'point'|'goodbye'} gesture
 * @property {'neutral'|'warm'|'delighted'|'serious'} emotion
 * @property {0|1|2|3|4} mouth
 */

/**
 * @typedef {Object} RiveInputAdapter
 * @property {(snapshot: AvatarSnapshot) => void} applySnapshot
 * @property {(name: string) => void} fireTrigger
 * @property {() => void} dispose
 */

const IDLE_SNAPSHOT = Object.freeze({ mode: 'idle', gesture: 'none', emotion: 'neutral', mouth: 0 });

/**
 * Generic avatar-command runtime -- same class shape/behavior as the SDK's
 * SommelierController.ts, renamed to reflect that it's not Rive-specific
 * (it works identically against the debug mock adapter).
 */
export class AvatarCommandRuntime {
    /**
     * @param {RiveInputAdapter} inputAdapter an ALREADY-INITIALIZED adapter
     *   (see this file's header -- no readiness handling happens here;
     *   that is the async factory's job).
     */
    constructor(inputAdapter) {
        this.inputAdapter = inputAdapter;
        /** @type {string|null} */
        this.activeGenerationId = null;
    }

    /**
     * Ignores any command whose generationId doesn't match the one
     * currently "claimed" -- identical stale-event guard to
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

        this.inputAdapter.applySnapshot({
            mode: command.mode,
            gesture: command.gesture,
            emotion: command.emotion,
            mouth: command.mouth,
        });
        if (command.blink) this.inputAdapter.fireTrigger('blink');
    }

    /**
     * Releases the claim on `id` and resets to a canonical idle snapshot.
     * A no-op if `id` isn't the currently-active generation (matches
     * SommelierController.ts's endGeneration exactly) -- this is what
     * makes interruption safe: cancelling an already-superseded
     * generation must not reset state a NEWER generation already claimed.
     * @param {string} id
     */
    endGeneration(id) {
        if (this.activeGenerationId !== id) return;
        this.inputAdapter.applySnapshot(IDLE_SNAPSHOT);
        this.activeGenerationId = null;
    }
}

/**
 * Mock/debug input adapter -- no Rive dependency at all, just tracks the
 * last applied snapshot plus a fire-count per trigger, and notifies a
 * callback so a UI (public/visual/debug/avatar-debug.mjs) can render it as
 * plain text. Implements the same RiveInputAdapter contract a real Rive
 * adapter will (applySnapshot/fireTrigger/dispose) -- this is what proves
 * the contract (schema + semantic adapter + runtime) is stable BEFORE any
 * real .riv exists.
 *
 * dispose() is idempotent (a second call is a no-op, never throws). After
 * dispose(), applySnapshot()/fireTrigger() throw -- fail-fast, mandatory
 * for every RiveInputAdapter implementation, not just this one (see file
 * header). getState() is a DEBUG/MOCK-ONLY convenience, not part of the
 * RiveInputAdapter contract itself -- a production Rive adapter is not
 * required to implement it. It remains readable after dispose() (harmless,
 * useful for a final UI read of the last known state).
 * @param {(state: object) => void} [onChange]
 * @returns {RiveInputAdapter & { getState: () => object }}
 */
export function createDebugInputAdapter(onChange = () => {}) {
    const KNOWN_TRIGGERS = new Set(['blink']);
    let snapshot = { ...IDLE_SNAPSHOT };
    const fireCounts = { blink: 0 };
    let disposed = false;

    function assertNotDisposed(action) {
        if (disposed) throw new TypeError(`debug_input_adapter_disposed: cannot ${action} after dispose()`);
    }

    function getState() {
        return { ...snapshot, blinkCount: fireCounts.blink };
    }

    return {
        applySnapshot(next) {
            assertNotDisposed('applySnapshot');
            snapshot = { mode: next.mode, gesture: next.gesture, emotion: next.emotion, mouth: next.mouth };
            onChange(getState());
        },
        fireTrigger(name) {
            assertNotDisposed('fireTrigger');
            if (!KNOWN_TRIGGERS.has(name)) throw new TypeError(`debug_input_adapter_unknown_trigger_input: ${name}`);
            fireCounts[name] += 1;
            onChange(getState());
        },
        dispose() {
            disposed = true; // idempotent: repeated calls just reassert the same flag, never throw
        },
        getState,
    };
}
