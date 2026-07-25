# State Machine Contract

Source of truth: `tools/WineMD-Character-SDK/03_rive/STATE_MACHINE.md`, `03_rive/rive_manifest.json`, `05_runtime/src/types.ts`, `05_runtime/src/SommelierController.ts`. All quoted verbatim below as of 2026-07-25 — this is unbuilt/unverified specification code (no `.riv` exists, and `SommelierController.ts` has never run against a real Rive instance), so re-read the actual files before trusting this summary if anything seems off.

## `SommelierSM` inputs (`STATE_MACHINE.md`, verbatim)

```
mode:    0 Idle, 1 Listening, 2 Thinking, 3 Speaking.
gesture: 0 None, 1 Welcome, 2 Present Wine, 3 Present Aroma, 4 Present Food, 5 Goodbye.
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
    { "name": "gesture", "type": "number", "values": { "none": 0, "welcome": 1, "presentWine": 2, "presentAroma": 3, "presentFood": 4, "goodbye": 5 } },
    { "name": "mouth", "type": "number", "values": { "neutral": 0, "A": 1, "E": 2, "O": 3, "MBP": 4 } },
    { "name": "blink", "type": "trigger" },
    { "name": "emotion", "type": "number", "values": { "neutral": 0, "warm": 1, "delighted": 2, "serious": 3 } }
  ]
}
```

Numeric values for `mode`, `emotion`, and the shared `gesture` subset match `STATE_MACHINE.md` exactly. Casing note: this JSON's `gesture.values` keys use camelCase (`presentWine`); the same manifest's top-level `requiredAnimations` array uses snake_case (`present_wine`) for the equivalent animation name — see `troubleshooting.md`.

## `types.ts` (full source, verbatim)

```ts
export type SommelierMode = "idle" | "listening" | "thinking" | "speaking";
export type SommelierGesture = "none" | "welcome" | "presentWine" | "presentAroma" | "presentFood" | "goodbye";
export type SommelierEmotion = "neutral" | "warm" | "delighted" | "serious";
export interface SommelierEvent { generationId: string; mode?: SommelierMode; gesture?: SommelierGesture; emotion?: SommelierEmotion; mouth?: 0|1|2|3|4; blink?: boolean; }
export const MODE_VALUE={idle:0,listening:1,thinking:2,speaking:3} as const;
export const GESTURE_VALUE={none:0,welcome:1,presentWine:2,presentAroma:3,presentFood:4,goodbye:5} as const;
export const EMOTION_VALUE={neutral:0,warm:1,delighted:2,serious:3} as const;
```

## `SommelierController.ts` (full source, verbatim)

```ts
import {GESTURE_VALUE,MODE_VALUE,EMOTION_VALUE,SommelierEvent} from "./types";
export interface RiveInputAdapter { setNumber(name:string,value:number):void; fire(name:string):void; }
export class SommelierController {
  private activeGenerationId:string|null=null;
  constructor(private readonly rive:RiveInputAdapter){}
  apply(event:SommelierEvent):void {
    if(this.activeGenerationId && event.generationId!==this.activeGenerationId) return;
    this.activeGenerationId ??= event.generationId;
    if(event.mode) this.rive.setNumber("mode",MODE_VALUE[event.mode]);
    if(event.gesture) this.rive.setNumber("gesture",GESTURE_VALUE[event.gesture]);
    if(event.emotion) this.rive.setNumber("emotion",EMOTION_VALUE[event.emotion]);
    if(typeof event.mouth==="number") this.rive.setNumber("mouth",event.mouth);
    if(event.blink) this.rive.fire("blink");
  }
  endGeneration(id:string):void {
    if(this.activeGenerationId!==id) return;
    this.rive.setNumber("mode",MODE_VALUE.idle); this.rive.setNumber("gesture",GESTURE_VALUE.none); this.rive.setNumber("mouth",0); this.activeGenerationId=null;
  }
}
```

**Stale-event protection, exact mechanism**: `apply()` silently no-ops if `activeGenerationId` is already set to something other than the incoming event's `generationId`. The first event for a fresh generation "claims" the controller (`??=`). This is the entire interruption/staleness guard — it is intentionally simple and depends entirely on whoever emits `SommelierEvent`s to call `endGeneration(id)` at the right time (on cancel/complete) to release the claim for the next turn. **This has never been tested against a real interruption scenario** — treat it as a hypothesis to verify with `references/testing-checklist.md`, not a proven guarantee.

## Real-vocabulary vs SDK-vocabulary — the mapping that does NOT yet exist

The real orchestrator (`src/visual/visualOrchestrator.js`) emits `visual.avatar.state` events with a `state` field from `AVATAR_STATES` (`idle, greeting, listening, thinking, speaking, enthusiastic, presenting_wine, pointing, confirming_order, goodbye`) plus free-form `gesture`/`emotion` strings (observed values today: `gesture` ∈ `{none, present_wine, present_pairing, present_cta}`; `emotion` ∈ `{attentive, focused, warm, enthusiastic, helpful, satisfied}`).

`SommelierEvent` only accepts `mode` ∈ `{idle, listening, thinking, speaking}`, `gesture` ∈ `{none, welcome, presentWine, presentAroma, presentFood, goodbye}`, `emotion` ∈ `{neutral, warm, delighted, serious}`.

No file anywhere defines the translation table between these two vocabularies. Building it is real work this skill's Phase 1/2 tasks require — a reasonable, honest starting map (to be verified against actual visual behavior, not assumed correct):

| Real `state` | → `SommelierMode` |
|---|---|
| `idle` | `idle` |
| `listening` | `listening` |
| `thinking` | `thinking` |
| `speaking`, `presenting_wine`, `pointing`, `confirming_order` | `speaking` (all four occur while audio is playing) |
| `greeting`, `enthusiastic`, `goodbye` | **no clean match** — `greeting`/`goodbye` are closer to `SommelierGesture` values than `SommelierMode`; `enthusiastic` isn't a mode at all in the SDK's model. Needs a real decision, not a guess baked in silently. |

| Real `gesture` string | → `SommelierGesture` |
|---|---|
| `present_wine` | `presentWine` |
| `present_pairing` | closest is `presentFood` (pairing = food matching) — **verify this is the intended meaning before shipping it**, don't assume |
| `present_cta` (commerce/order) | **no match** — none of `welcome/presentWine/presentAroma/presentFood/goodbye` fits "confirm order"; flag as a gap |
| `none` | `none` |
| *(no gesture currently fires for the AROMAS phase — see `architecture.md`)* | `presentAroma` has **nothing to map from today** |

Do not silently "fix" this by inventing new real-orchestrator gesture values without discussing it — that's a change to `src/visual/visualOrchestrator.js`, production code, and falls under this skill's "don't rewrite the architecture without necessity" rule. Surface the gap and let the person directing the work decide.
