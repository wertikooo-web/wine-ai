// SPECIFICATION / REFERENCE ONLY. This file does not compile or run as
// part of the current application -- this repo has no TypeScript build
// step (see 05_runtime/README.md) and nothing here is imported by any
// executed code path. It exists purely to document the SDK's own spec
// for comparison against the project's real implementation.
//
// The runtime source of truth is public/visual/*.mjs -- specifically
// avatarCommandSchema.mjs, avatarSemanticAdapter.mjs, and
// riveAvatarAdapter.mjs (AvatarCommandRuntime + createDebugInputAdapter).
// Keep this file in sync with those manually if either changes; never
// treat a change here as having taken effect in the running app.

import {SommelierMode,SommelierGesture,SommelierEmotion,SommelierEvent} from "./types";

// RiveInputAdapter contract fixed 2026-07-25 (post interface-boundary
// audit -- see public/visual/riveAvatarAdapter.mjs's file header and
// ../../../.claude/skills/winemd-rive/references/state-machine-contract.md
// for full rationale). applySnapshot() replaces four separate setNumber()
// calls so mode/gesture/emotion/mouth are applied as one atomic unit -- a
// real state machine can never observe a partially-updated combination.
//
// Snapshot values are the SAME SEMANTIC strings/numbers SommelierEvent
// carries (e.g. mode: "speaking") -- NOT pre-converted to Rive's numeric
// state-machine values. Converting semantic names to whatever a specific
// engine needs is the ADAPTER's own concern, never this controller's --
// this keeps SommelierController (and the project's real equivalent,
// AvatarCommandRuntime) vendor-neutral; RiveInputAdapter is deliberately
// the one place allowed to know about Rive's numeric encoding. See
// types.ts's MODE_VALUE/GESTURE_VALUE/EMOTION_VALUE -- those are Rive
// IMPLEMENTATION mapping tables for a future real adapter to use
// internally, not runtime mapping this controller performs.
//
// dispose() must be idempotent; after dispose(), applySnapshot()/
// fireTrigger() must throw (fail-fast), matching the project's own
// createDebugInputAdapter() in riveAvatarAdapter.mjs.
export interface RiveInputAdapter {
  applySnapshot(snapshot: { mode: SommelierMode; gesture: SommelierGesture; emotion: SommelierEmotion; mouth: 0|1|2|3|4 }): void;
  fireTrigger(name: string): void;
  dispose(): void;
}

// Async factory contract -- TYPE DECLARATION ONLY, no implementation and
// no runtime export exists anywhere (no Rive SDK dependency in this repo
// yet). Loading Rive (WASM + fetching the .riv file + validating the
// state machine's inputs) is inherently asynchronous, so a real adapter
// MUST be created this way, never via a synchronous constructor.
// SommelierController (and the project's real AvatarCommandRuntime) is
// constructed ONLY with an already-initialized adapter, i.e. only after
// this Promise resolves -- there is no isReady()/onReady()/buffering
// anywhere in this contract, by design; readiness is entirely the
// factory's responsibility.
export type RiveInputAdapterOptions = Record<string, unknown>;
export type CreateRiveInputAdapter = (options: RiveInputAdapterOptions) => Promise<RiveInputAdapter>;
// Rejection contract: if any state-machine input this interface requires
// (mode, gesture, emotion, mouth, blink) is missing from the loaded state
// machine, the returned Promise MUST reject with an Error naming the
// missing input, e.g. `new Error("rive_input_adapter_missing_required_input: gesture")`.
// Once resolved, applySnapshot()/fireTrigger() MUST NOT re-resolve inputs
// by name again -- name resolution happens once, during init.

const DEFAULT_MODE: SommelierMode = "idle";
const DEFAULT_GESTURE: SommelierGesture = "none";
const DEFAULT_EMOTION: SommelierEmotion = "neutral";

export class SommelierController {
  private activeGenerationId:string|null=null;
  constructor(private readonly rive:RiveInputAdapter){}
  apply(event:SommelierEvent):void {
    if(this.activeGenerationId && event.generationId!==this.activeGenerationId) return;
    this.activeGenerationId ??= event.generationId;
    // SommelierEvent's fields are optional (partial-update semantics in
    // this SDK spec); the project's actual AvatarCommand always carries
    // all four, filled with these same defaults by createAvatarCommand()
    // (avatarCommandSchema.mjs). Resolving undefined fields to defaults
    // here keeps this spec's apply() shaped like a real RiveInputAdapter
    // caller, which always sends a full semantic snapshot -- no numeric
    // conversion happens in this controller at all.
    this.rive.applySnapshot({
      mode: event.mode ?? DEFAULT_MODE,
      gesture: event.gesture ?? DEFAULT_GESTURE,
      emotion: event.emotion ?? DEFAULT_EMOTION,
      mouth: typeof event.mouth === "number" ? event.mouth : 0,
    });
    if(event.blink) this.rive.fireTrigger("blink");
  }
  endGeneration(id:string):void {
    if(this.activeGenerationId!==id) return;
    this.rive.applySnapshot({ mode: DEFAULT_MODE, gesture: DEFAULT_GESTURE, emotion: DEFAULT_EMOTION, mouth: 0 });
    this.activeGenerationId=null;
  }
}
