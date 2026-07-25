# State Machine Contract

Source of truth: `tools/WineMD-Character-SDK/03_rive/STATE_MACHINE.md`, `03_rive/rive_manifest.json`, `05_runtime/src/types.ts`, `05_runtime/src/SommelierController.ts`. All quoted verbatim below as of 2026-07-25 (post-review — gesture casing unified to snake_case, a generic `point` gesture added, and `smile` removed entirely after being flagged as contract drift, see `troubleshooting.md` #1/#2/#7) — this is unbuilt/unverified specification code (no `.riv` exists, and `SommelierController.ts` has never run against a real Rive instance), so re-read the actual files before trusting this summary if anything seems off.

**The project's actual canonical JS contract is `public/visual/avatarCommandSchema.mjs` + `avatarSemanticAdapter.mjs` + `riveAvatarAdapter.mjs`** (added 2026-07-25) — this file documents the SDK's own TS specification for reference/comparison, but code should depend on the `.mjs` files, not this doc or the `.ts` files (no TS build step exists in this repo).

## `SommelierSM` inputs (`STATE_MACHINE.md`, verbatim)

```
mode:    0 Idle, 1 Listening, 2 Thinking, 3 Speaking.
gesture: 0 None, 1 Welcome, 2 Present Wine, 3 Present Aroma, 4 Present Food, 5 Point, 6 Goodbye.
mouth:   0 Neutral, 1 A, 2 E, 3 O, 4 MBP.
blink:   trigger.
emotion: 0 Neutral, 1 Warm, 2 Delighted, 3 Serious.
```

Priority order when multiple would apply: **Welcome/Goodbye > presentation gestures > Speaking > Listening/Thinking > Idle.**

## `rive_manifest.json`'s `stateMachine` block (verbatim JSON)

```json
{
  "name": "SommelierSM",
  "inputs": [
    { "name": "mode", "type": "number", "values": { "idle": 0, "listening": 1, "thinking": 2, "speaking": 3 } },
    { "name": "gesture", "type": "number", "values": { "none": 0, "welcome": 1, "present_wine": 2, "present_aroma": 3, "present_food": 4, "point": 5, "goodbye": 6 } },
    { "name": "mouth", "type": "number", "values": { "neutral": 0, "A": 1, "E": 2, "O": 3, "MBP": 4 } },
    { "name": "blink", "type": "trigger" },
    { "name": "emotion", "type": "number", "values": { "neutral": 0, "warm": 1, "delighted": 2, "serious": 3 } }
  ]
}
```

Numeric values for `mode`, `emotion`, and `gesture` match `STATE_MACHINE.md` exactly and are snake_case throughout, matching `requiredAnimations`' casing (fixed 2026-07-25 — see `troubleshooting.md` #1). `point` (2026-07-25 post-review, `troubleshooting.md` #7) is a generic gesture, distinct from `present_food`.

## `types.ts` (full source, verbatim)

```ts
export type SommelierMode = "idle" | "listening" | "thinking" | "speaking";
export type SommelierGesture = "none" | "welcome" | "present_wine" | "present_aroma" | "present_food" | "point" | "goodbye";
export type SommelierEmotion = "neutral" | "warm" | "delighted" | "serious";
export interface SommelierEvent { generationId: string; mode?: SommelierMode; gesture?: SommelierGesture; emotion?: SommelierEmotion; mouth?: 0|1|2|3|4; blink?: boolean; }
export const MODE_VALUE={idle:0,listening:1,thinking:2,speaking:3} as const;
export const GESTURE_VALUE={none:0,welcome:1,present_wine:2,present_aroma:3,present_food:4,point:5,goodbye:6} as const;
export const EMOTION_VALUE={neutral:0,warm:1,delighted:2,serious:3} as const;
```

## `SommelierController.ts` (full source, verbatim)

```ts
import {SommelierMode,SommelierGesture,SommelierEmotion,SommelierEvent} from "./types";
export interface RiveInputAdapter {
  applySnapshot(snapshot: { mode: SommelierMode; gesture: SommelierGesture; emotion: SommelierEmotion; mouth: 0|1|2|3|4 }): void;
  fireTrigger(name: string): void;
  dispose(): void;
}
const DEFAULT_MODE: SommelierMode = "idle";
const DEFAULT_GESTURE: SommelierGesture = "none";
const DEFAULT_EMOTION: SommelierEmotion = "neutral";
export class SommelierController {
  private activeGenerationId:string|null=null;
  constructor(private readonly rive:RiveInputAdapter){}
  apply(event:SommelierEvent):void {
    if(this.activeGenerationId && event.generationId!==this.activeGenerationId) return;
    this.activeGenerationId ??= event.generationId;
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
```

Note: semantic values pass straight through `applySnapshot()` — no numeric conversion happens in the controller. `types.ts`'s `MODE_VALUE`/`GESTURE_VALUE`/`EMOTION_VALUE` are Rive **implementation** mapping (for a future real adapter's internal use), not runtime mapping this controller performs.

**Stale-event protection, exact mechanism**: `apply()` silently no-ops if `activeGenerationId` is already set to something other than the incoming event's `generationId`. The first event for a fresh generation "claims" the controller (`??=`). This is the entire interruption/staleness guard — it is intentionally simple and depends entirely on whoever emits `SommelierEvent`s to call `endGeneration(id)` at the right time (on cancel/complete) to release the claim for the next turn. **This has never been tested against a real interruption scenario** — treat it as a hypothesis to verify with `references/testing-checklist.md`, not a proven guarantee.

## `RiveInputAdapter` interface (fixed 2026-07-25, post interface-boundary audit)

Full rationale lives in the audit conversation this fix came from; summarized contract:

- **`applySnapshot({mode, gesture, emotion, mouth})`** — applies all four state-machine inputs as ONE atomic call. Replaces four separate `setNumber()` calls (the SDK's original shape) specifically so a real state machine can never observe a partially-updated combination (new `mode` with stale `gesture`, etc.) between two of them. Both this TS spec's `SommelierController.apply()` and the project's actual JS runtime (`public/visual/riveAvatarAdapter.mjs`'s `AvatarCommandRuntime.apply()`) pass semantic string/enum values straight through (e.g. `mode: 'speaking'`), NOT pre-converted numbers — converting to whatever a specific engine needs (Rive's numeric enums, or anything else) is the ADAPTER's own concern exclusively, never the controller/runtime's. `types.ts`'s `MODE_VALUE`/`GESTURE_VALUE`/`EMOTION_VALUE` tables are kept as Rive **implementation** mapping — reference values for whichever future real adapter talks to the actual Rive SDK — not something either controller performs itself.
- **`fireTrigger(name)`** — fires a one-shot trigger (e.g. `"blink"`). Separate from `applySnapshot` because triggers are momentary events, not persistent state.
- **`dispose()`** — this lifecycle contract is **mandatory for every RiveInputAdapter implementation**, mock or production, with no exceptions — mock and production MUST NOT have different lifecycle semantics:
  - `dispose()` MUST be idempotent (a second, or later, call MUST NOT throw).
  - `applySnapshot()` called after `dispose()` MUST throw a clear lifecycle error.
  - `fireTrigger()` called after `dispose()` MUST throw a clear lifecycle error.
  Rationale: silently swallowing calls into a disposed adapter would hide real bugs (a caller that forgot to stop sending commands after teardown) — this is a required property of the contract itself, not a debug-tool-only convenience.
- **`getState()`** — DEBUG/MOCK-ONLY. Not part of the `RiveInputAdapter` contract — only `createDebugInputAdapter()` exposes it, so the debug harness can render plain-text state. A production Rive adapter is not required to implement it.

**Naming**: stays `RiveInputAdapter`, not renamed to something vendor-neutral, because it IS the lower boundary specifically with Rive. The vendor-neutral contract already lives one layer up: `AvatarCommand` (`avatarCommandSchema.mjs`) and `AvatarCommandRuntime` (`riveAvatarAdapter.mjs`). Swapping animation engines later means writing a new adapter satisfying this same shape, not renaming this one.

**Decision record — `visual.timeline.complete` does NOT call `endGeneration()`** (Avatar Contract v1, fixed 2026-07-25): when a generation finishes normally, `AvatarCommandRuntime` deliberately leaves that generation's claim in place, and the avatar stays in whatever idle snapshot the orchestrator's own `onAudioEnd()` → `avatarState('idle', ...)` already produced. The claim is released only by an explicit reset/cancel (`visual.reset` / `visual.timeline.cancel`, both routed through `endGeneration()` by any consumer, e.g. `avatar-debug.mjs`) or by the next generation's first command superseding it. This is intentional, documented v1 behavior — **not an unfixed bug**. (A future ambient/idle-driven command source calling `apply()` between turns would need this revisited, but no such source exists yet.)

**Async factory contract (NOT implemented — no Rive SDK dependency exists in this repo yet)**:

```
async function createRiveInputAdapter(options) -> Promise<RiveInputAdapter>
```

- Loading Rive (WASM + fetching the `.riv` file + validating the state machine's inputs) is inherently asynchronous, so adapter creation MUST be an async factory, never a synchronous constructor.
- `AvatarCommandRuntime` is constructed ONLY with an ALREADY-INITIALIZED adapter — i.e. only after `await createRiveInputAdapter(options)` resolves. `AvatarCommandRuntime` itself has no `isReady()`/`onReady()` and does no buffering of pre-ready commands, BY DESIGN — readiness is entirely the factory's responsibility.
- During initialization, the factory MUST verify every state-machine input this contract requires (`mode`, `gesture`, `emotion`, `mouth`, `blink`) actually exists on the loaded state machine.
- If any required input is missing, the factory MUST reject with an `Error` whose message names the missing input, e.g. `new Error('rive_input_adapter_missing_required_input: gesture')` — never silently ignore a missing required input.
- Once the Promise resolves, `applySnapshot()`/`fireTrigger()` MUST NOT re-resolve/look up inputs by name again — name-to-input resolution happens once, during init, and is cached internally, not repeated per call.

**Deliberately excluded from this contract** (do not add without a fresh review): callbacks from Rive, `subscribe`/`onEvent`, gesture-complete events, runtime capability negotiation, `pause`/`resume`, `attachCanvas`/`detachCanvas`, an adapter registry, or support for other animation engines.

## Real-vocabulary vs SDK-vocabulary — now built (2026-07-25)

**This mapping now exists** as code, not just a plan: `public/visual/avatarSemanticAdapter.mjs`'s `STATE_MAP` and `EMOTION_MAP` constants, each entry tagged `mapped` / `fallback` / `unsupported` per the exact rules requested (see that file's header comment for the full reasoning per state). Read it directly rather than this doc for the current, authoritative mapping — this section is history/context for *why* the mapping looks the way it does, not the mapping itself anymore.

Summary of the resolved decisions (full detail + rationale in `avatarSemanticAdapter.mjs`):
- `idle`, `listening`, `thinking`, `speaking` → direct 1:1 (`kind: 'mapped'`).
- `presenting_wine` → mode `speaking`, gesture `present_wine` (`mapped`).
- `pointing` (real orchestrator's only PAIRING-phase state) → mode `speaking`, gesture `point` — a generic gesture, since `pointing` itself carries no food/pairing semantics; only its current caller does. `present_food` stays reserved, unused, for a future explicit pairing/food event. (Revised 2026-07-25 post-review — originally mapped to `present_food`, which tied a generic gesture to business semantics just because of who currently calls it. See `troubleshooting.md` #7.)
- `confirming_order` → mode `speaking`, gesture `none` — tagged `unsupported`: no `SommelierGesture` value fits "confirm this order" at all.
- `greeting`, `enthusiastic`, `goodbye` → tagged `fallback`: declared in `AVATAR_STATES` but never actually emitted by any current orchestrator code path; each falls back to a safe default rather than inventing new production behavior.
- `emotion` free-form strings (`attentive/focused/warm/enthusiastic/helpful/satisfied`) → nearest-fit `SommelierEmotion` values, only `warm` is an exact match; every other mapping is a labeled approximation in `EMOTION_MAP`.
- **`presentAroma`/`present_aroma` has nothing to map from** — confirmed still true: `runPhase('AROMAS')` in `visualOrchestrator.js` never calls `avatarState()`. See "Proposed orchestrator change (not implemented)" below.
- **`mouth`** is derived from `visual.avatar.state`'s continuous `mouthOpen` amplitude via a 2-threshold classifier (`amplitudeToMouth()` in `avatarSemanticAdapter.mjs`) — not real viseme detection, matches the documented MVP scope (`MOUTH_AND_EYES.md`: neutral/A/M-B-P only).
- **`blink`** is never derived from any event — the canonical `AvatarCommand` always carries `blink: false` from the semantic adapter; autonomous idle-blink is a runtime-timer concern, not a semantic-translation one (see `ANIMATIONS.md`'s "Idle... random blink").

## Proposed orchestrator change for `present_aroma` (NOT implemented — proposal only)

To give AROMAS phase a real gesture signal, `src/visual/visualOrchestrator.js`'s `runPhase('AROMAS')` would need one added line, analogous to the PAIRING phase:
```js
if (phase === 'AROMAS') {
    avatarState('pointing', { emotion: 'warm', gesture: 'present_aroma', intensity: 0.7 }); // NEW
    return emitEvent('visual.aromas.show', { wineId: knowledge.wineId, descriptors: aromas });
}
```
This is a real, scoped change to production code (`visualOrchestrator.js`) — per this skill's "don't rewrite the architecture without necessity" rule, it is deliberately **not applied** here. It's a one-line proposal for whoever owns that file to accept or reject, not something the avatar skill should do unilaterally.
