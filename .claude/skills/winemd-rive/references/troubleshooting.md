# Troubleshooting

Every known inconsistency found by directly comparing `tools/WineMD-Character-SDK/` docs against each other and against the real `src/visual/*` code, as of 2026-07-25. Re-verify against current files before relying on this if it's been a while — the SDK docs or real code may have changed.

## 1. Gesture casing clash inside `rive_manifest.json` itself

`stateMachine.inputs[].gesture.values` uses camelCase (`presentWine`, `presentAroma`, `presentFood`), but the same file's top-level `requiredAnimations` array uses snake_case (`present_wine`, `present_aroma`, `present_food`) for what should be the same concept. No mapping table exists anywhere.

**Resolution when building the rig**: pick one convention for the actual Rive animation names inside the `.riv` file (snake_case matches `EXPORT_RULES.md`'s general naming convention, so probably keep animation clip names snake_case), and make sure whatever code triggers animations by name (if any — a State Machine may handle this internally via its own transition graph, in which case the animation *names* inside Rive don't need to match the *input value* names at all, only the transition logic needs to reference the right clips). Verify how Rive's own transition graph actually resolves this before assuming JS-side code needs an explicit name-mapping table.

## 2. `smile` is a required animation with no way to trigger it

`rive_manifest.json`'s `requiredAnimations` includes `smile`, but `STATE_MACHINE.md`'s input list (`mode`, `gesture`, `mouth`, `blink`, `emotion`) has nothing that could invoke it, and neither `types.ts`'s `SommelierEvent` nor `SommelierController.ts`'s `apply()` has any field or branch for it.

**Resolution options** (pick one, don't invent a third silently):
- (a) Add a `smile` trigger input to the state machine + a `smile?: boolean` field to `SommelierEvent` + a branch in `SommelierController.apply()`, analogous to `blink`.
- (b) Treat `smile` as folded into the `goodbye` animation clip (per `ANIMATIONS.md`: "Goodbye — warm smile, small nod, return to neutral") and remove it from `requiredAnimations` as a standalone clip.
- Don't build an animation nothing can ever play; that's wasted rig work.

## 3. `VISUAL_EVENTS.md`'s worked example is incomplete

The only example event in `06_winemd/VISUAL_EVENTS.md` is `{"generationId":"answer-123","mode":"speaking","gesture":"presentAroma","emotion":"warm"}` — no `mouth` or `blink`, even though both are valid optional `SommelierEvent` fields that `SommelierController.apply()` actively handles. Don't assume this means `mouth`/`blink` are lower-priority or optional-in-practice; they're just not demonstrated in that one example.

## 4. No mapping between the real `AVATAR_STATES` vocabulary and the SDK's `SommelierMode`/`SommelierGesture`/`SommelierEmotion`

This is the biggest one — full detail and a starting proposed mapping table live in `state-machine-contract.md`'s final section. Summary: real states `greeting`, `enthusiastic`, `goodbye` (as `AVATAR_STATES` values) don't cleanly become a `SommelierMode`; real gestures `present_pairing`/`present_cta` don't cleanly become `SommelierGesture` values; nothing in production currently emits a gesture for the AROMAS phase at all. `06_winemd/INTEGRATION_PLAN.md` step 4 assumes this translation is straightforward ("Convert Visual Orchestrator events to `SommelierEvent`") — it is not, and building it honestly (with named gaps, not silent guesses) is real Phase 1/2 work.

## 5. Next.js assumption mismatch

`09_examples/nextjs/README.md` and `INTEGRATION_PLAN.md` step 1 assume a React/Next.js `SommelierAvatar` component. This repo has zero React/Next.js anywhere (verified via `package.json` dependencies and an empty `.jsx`/`.tsx` search). Follow `runtime-integration.md`'s vanilla-JS approach instead — modeled on `public/visual/VisualStoryController.mjs`, not the SDK's own example.

## 6. The SDK self-labels as unfinished — take that seriously

`README.md` states outright: "A genuine layered PSD and binary `.riv` cannot be reconstructed perfectly from one flattened PNG. Hidden geometry must be drawn and the rig must be assembled in an editor." `rive_manifest.json`'s own `"status"` field says `"production specification / starter implementation"`. Nothing in this SDK has been rigged, reviewed in Rive, or run against real code. Don't let the specification's thoroughness (it IS thorough and mostly internally consistent apart from the gaps above) create false confidence that any of it is built yet.

## Quick diagnostic questions when something seems off

- "Is this file real, or does `tools/WineMD-Character-SDK/`'s own docs already admit it's a placeholder?" — check `README.md` and any `"status"` field first.
- "Did I open this file THIS session, or am I recalling it from a reference doc (including this one)?" — reference docs can go stale; the real files are the source of truth.
- "Does a `.riv` file actually exist at the path I'm about to reference?" — check, every time, don't assume from a prior session.
- "Am I about to map a real production event field to an SDK field with no documented mapping?" — check `state-machine-contract.md`'s gap table first; don't invent a mapping silently.
