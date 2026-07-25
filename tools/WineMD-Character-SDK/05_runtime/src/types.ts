// Naming convention fixed 2026-07-25: gesture values are snake_case
// throughout (previously camelCase here, snake_case in rive_manifest.json's
// requiredAnimations — see 03_rive/STATE_MACHINE.md's note and
// .claude/skills/winemd-rive/references/troubleshooting.md #1). Added a
// generic `point` gesture (distinct from `present_food`) since the real
// orchestrator's `pointing` state carries no food/pairing semantics of its
// own — see troubleshooting.md #7. `smile` was removed entirely: it was a
// required animation with no real event ever driving it, i.e. an input
// that existed only to silence a manifest warning (troubleshooting.md #4).
// Re-add only once a real orchestrator event signals a smile moment.
//
// The project's actual runtime port of this file is
// public/visual/avatarCommandSchema.mjs (plain JS — this repo has no
// TypeScript build step, see 05_runtime/README.md's note plus
// .claude/skills/winemd-rive/references/runtime-integration.md). Keep
// both in sync manually if either changes.
export type SommelierMode = "idle" | "listening" | "thinking" | "speaking";
export type SommelierGesture = "none" | "welcome" | "present_wine" | "present_aroma" | "present_food" | "point" | "goodbye";
export type SommelierEmotion = "neutral" | "warm" | "delighted" | "serious";
export interface SommelierEvent { generationId: string; mode?: SommelierMode; gesture?: SommelierGesture; emotion?: SommelierEmotion; mouth?: 0|1|2|3|4; blink?: boolean; }
// Rive IMPLEMENTATION mapping (not runtime mapping): the numeric encodings
// a real Rive state machine expects for these inputs. Post interface-
// boundary audit (2026-07-25), NOTHING in this repo's actual code consumes
// these maps -- neither SommelierController.apply() nor the project's real
// AvatarCommandRuntime (public/visual/riveAvatarAdapter.mjs) ever converts
// semantic values to numbers; both pass semantic string/enum values
// straight through via applySnapshot(). These tables exist purely as
// specification for whichever future real RiveInputAdapter implementation
// talks to the actual Rive SDK -- THAT adapter (not the controller/runtime
// above it) is responsible for this conversion. Kept here rather than
// deleted because a real .riv build still needs these exact numbers.
export const MODE_VALUE={idle:0,listening:1,thinking:2,speaking:3} as const;
export const GESTURE_VALUE={none:0,welcome:1,present_wine:2,present_aroma:3,present_food:4,point:5,goodbye:6} as const;
export const EMOTION_VALUE={neutral:0,warm:1,delighted:2,serious:3} as const;
