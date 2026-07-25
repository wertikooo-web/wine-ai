# Troubleshooting

Every known inconsistency found by directly comparing `tools/WineMD-Character-SDK/` docs against each other and against the real `src/visual/*` code, as of 2026-07-25. Re-verify against current files before relying on this if it's been a while — the SDK docs or real code may have changed.

## 1. Gesture casing clash inside `rive_manifest.json` itself — RESOLVED 2026-07-25

`stateMachine.inputs[].gesture.values` uses camelCase (`presentWine`, `presentAroma`, `presentFood`), but the same file's top-level `requiredAnimations` array uses snake_case (`present_wine`, `present_aroma`, `present_food`) for what should be the same concept. No mapping table exists anywhere.

**Resolved**: `gesture` input values in `rive_manifest.json`, `STATE_MACHINE.md`, and the SDK's `types.ts`/`SommelierController.ts` are now snake_case throughout (`present_wine`, `present_aroma`, `present_food`), matching `requiredAnimations`' casing. The project's own canonical schema (`public/visual/avatarCommandSchema.mjs`) uses the same snake_case `GESTURES` list. No mapping table is needed anymore since both sides use one convention.

## 2. `smile` is a required animation with no way to trigger it — RESOLVED 2026-07-25, then REVERTED 2026-07-25 (post-review)

`rive_manifest.json`'s `requiredAnimations` included `smile`, but `STATE_MACHINE.md`'s input list (`mode`, `gesture`, `mouth`, `blink`, `emotion`) had nothing that could invoke it, and neither `types.ts`'s `SommelierEvent` nor `SommelierController.ts`'s `apply()` had any field or branch for it.

**First attempt (option a, since reverted)**: added a `smile` trigger input to `rive_manifest.json`/`STATE_MACHINE.md`, a `smile?: boolean` field to `SommelierEvent` (`types.ts`), and a matching branch in `SommelierController.apply()`. This was flagged in post-implementation review as contract drift: an input added only to silence the manifest validator's warning, never actually wired into the project's canonical `AvatarCommand` (`public/visual/avatarCommandSchema.mjs`/`avatarSemanticAdapter.mjs`) because no real orchestrator event signals a smile moment.

**Resolved via option (b)**: `smile` removed entirely — from `requiredAnimations`, `STATE_MACHINE.md`, `types.ts`'s `SommelierEvent`, and `SommelierController.apply()`. Re-add only once a real orchestrator event exists to drive it, and wire it end-to-end (schema + adapter + runtime) in the same change — not as an input that exists solely to pass validation.

## 3. `VISUAL_EVENTS.md`'s worked example is incomplete

The only example event in `06_winemd/VISUAL_EVENTS.md` is `{"generationId":"answer-123","mode":"speaking","gesture":"presentAroma","emotion":"warm"}` — no `mouth` or `blink`, even though both are valid optional `SommelierEvent` fields that `SommelierController.apply()` actively handles. Don't assume this means `mouth`/`blink` are lower-priority or optional-in-practice; they're just not demonstrated in that one example.

## 4. No mapping between the real `AVATAR_STATES` vocabulary and the SDK's `SommelierMode`/`SommelierGesture`/`SommelierEmotion`

This is the biggest one — full detail and a starting proposed mapping table live in `state-machine-contract.md`'s final section. Summary: real states `greeting`, `enthusiastic`, `goodbye` (as `AVATAR_STATES` values) don't cleanly become a `SommelierMode`; real gestures `present_pairing`/`present_cta` don't cleanly become `SommelierGesture` values; nothing in production currently emits a gesture for the AROMAS phase at all. `06_winemd/INTEGRATION_PLAN.md` step 4 assumes this translation is straightforward ("Convert Visual Orchestrator events to `SommelierEvent`") — it is not, and building it honestly (with named gaps, not silent guesses) is real Phase 1/2 work.

## 5. Next.js assumption mismatch

`09_examples/nextjs/README.md` and `INTEGRATION_PLAN.md` step 1 assume a React/Next.js `SommelierAvatar` component. This repo has zero React/Next.js anywhere (verified via `package.json` dependencies and an empty `.jsx`/`.tsx` search). Follow `runtime-integration.md`'s vanilla-JS approach instead — modeled on `public/visual/VisualStoryController.mjs`, not the SDK's own example.

## 6. The SDK self-labels as unfinished — take that seriously

`README.md` states outright: "A genuine layered PSD and binary `.riv` cannot be reconstructed perfectly from one flattened PNG. Hidden geometry must be drawn and the rig must be assembled in an editor." `rive_manifest.json`'s own `"status"` field says `"production specification / starter implementation"`. Nothing in this SDK has been rigged, reviewed in Rive, or run against real code. Don't let the specification's thoroughness (it IS thorough and mostly internally consistent apart from the gaps above) create false confidence that any of it is built yet.

## 7. `pointing -> present_food` tied a generic gesture to business semantics — RESOLVED 2026-07-25 (post-review)

The original mapping (`public/visual/avatarSemanticAdapter.mjs`'s `STATE_MAP`) sent the real orchestrator's `pointing` state to the SDK's `present_food` gesture, reasoning only from the fact that `runPhase('PAIRING')` is currently its one caller. `pointing` itself carries no food/pairing meaning — that reasoning bakes in current-caller behavior as if it were the state's intrinsic semantics, which breaks the moment `pointing` is used from anywhere else.

**Resolved**: added a generic `point` gesture (`rive_manifest.json`, `STATE_MACHINE.md`, `types.ts`, `SommelierController.ts`, `public/visual/avatarCommandSchema.mjs`/`riveAvatarAdapter.mjs`). `pointing -> point` now. `present_food` remains reserved, unused by any current mapping, for when the orchestrator emits an explicit pairing/food-presentation event (see `state-machine-contract.md`'s "Proposed orchestrator change" section for `present_aroma` — the same pattern would apply here).

## Quick diagnostic questions when something seems off

- "Is this file real, or does `tools/WineMD-Character-SDK/`'s own docs already admit it's a placeholder?" — check `README.md` and any `"status"` field first.
- "Did I open this file THIS session, or am I recalling it from a reference doc (including this one)?" — reference docs can go stale; the real files are the source of truth.
- "Does a `.riv` file actually exist at the path I'm about to reference?" — check, every time, don't assume from a prior session.
- "Am I about to map a real production event field to an SDK field with no documented mapping?" — check `state-machine-contract.md`'s gap table first; don't invent a mapping silently.
