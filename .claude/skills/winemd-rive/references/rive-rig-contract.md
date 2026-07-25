# Rive Rig Contract

Source of truth: `tools/WineMD-Character-SDK/03_rive/CONSTRAINTS.md`, `bone_scheme.png`, and `rive_manifest.json`. No `.riv` file exists yet anywhere in this repo (verified 2026-07-25 via exhaustive `**/*.riv` search — zero results) — everything below is the *target* for whoever builds the rig in the Rive editor, not a description of an existing asset.

## Artboard

- Name: `Sommelier`
- Recommended size: `1536 x 1024` (from `rive_manifest.json`'s `artboard.recommendedSize`)

## Bones (`rive_manifest.json`'s `bones` array, verbatim order)

```
root, chest, neck, head, shoulder_l, elbow_l, hand_l, shoulder_r, elbow_r, hand_r
```

Cross-check against `03_rive/bone_scheme.png` (a 14.6 KB diagram — small enough to be a schematic line-drawing, not painted art; treat it as the bone-placement reference, open it directly rather than assuming this list is complete/correct).

## Movement constraints (`CONSTRAINTS.md`, verbatim)

- Head rotation: ±6°
- Chest breathing: 2-4 px
- Shoulder rotation: max 18° (idle gestures)
- Elbow rotation: max 35°
- Hand rotation: max 15°
- Eye target clamp: ~12% of eye width
- Blink duration: 100-160 ms

These are deliberately small ranges — the character should read as calm/professional, not cartoonish. A rig that exceeds these (e.g. a 30° head turn) is out of spec even if it "looks fine" in isolation.

## Required animations (`rive_manifest.json`'s `requiredAnimations`, verbatim)

```
idle, listening, thinking, speaking, welcome, present_wine, present_aroma,
present_food, goodbye, blink, smile
```

**Known gap (see `troubleshooting.md`):** `smile` is required here but has no corresponding State Machine input, trigger, or `SommelierEvent` field anywhere in the runtime contract — nothing in the documented pipeline can ever play it. Before building a `smile` animation, either (a) add a real trigger for it to `state-machine-contract.md`'s inputs and `SommelierController.ts`, or (b) flag it back to whoever owns the SDK spec as dead weight, rather than silently building an unreachable animation.

## What this reference cannot verify

Nothing here can confirm bone naming, weight painting, or mesh deformation quality without opening the actual `.riv` file in the Rive editor once one exists — a text-based skill has no way to inspect binary rig internals. `scripts/validate-rive-manifest.mjs` checks the JSON manifest for internal consistency (names/values), not the rig itself.
