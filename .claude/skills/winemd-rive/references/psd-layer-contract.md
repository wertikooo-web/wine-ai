# PSD Layer Contract

Source of truth: `tools/WineMD-Character-SDK/02_psd_spec/*.md`. Quoted verbatim below as of 2026-07-25 — re-read the source files if this skill is being used long after that date, in case the spec changed.

## Layer tree (`PSD_LAYER_TREE.md`, verbatim)

```
guides
hair_front
  fringe_left
  fringe_right
  loose_strand_left
  loose_strand_right
face
  brow_left
  brow_right
  eyelid_left
  eyelid_right
  eye_white_left
  eye_white_right
  iris_left
  iris_right
  pupil_left
  pupil_right
  nose
  mouth
    mouth_neutral
    mouth_A
    mouth_E
    mouth_O
    mouth_MBP
    teeth
    tongue
  face_base
hair_back
head
neck
torso
  grape_pin
  bow_tie
  vest_front
  shirt_front
arm_left
  upper_arm_left
  forearm_left
  hand_left
arm_right
  upper_arm_right
  forearm_right
  hand_right
props
  bottle
  wine_glass
  counter_front
  counter_top
```

Use these exact snake_case names — `EXPORT_RULES.md` requires it, and `scripts/validate-character-assets.mjs` checks exported filenames against this list where applicable.

## Mouth and eyes (`MOUTH_AND_EYES.md`, verbatim)

- Mouth shapes: `neutral`, `A`, `E`, `O`, `M-B-P`.
- Eyes: `open`, `half-closed`, `closed`; pupils are separate layers from the whites; brows are separate from the face.
- **For MVP**, audio amplitude may switch between only `neutral`, `A`, and `M-B-P` — the full `E`/`O` set is not required until later refinement (this is a legitimate MVP scoping decision already made in the spec, not a shortcut to flag as incomplete).

## Hidden geometry (`HIDDEN_GEOMETRY.md`, verbatim)

Redraw all areas currently covered by another part:
- full shoulders beneath sleeves
- upper arms beneath cuffs
- forearms beneath hands
- full vest and shirt beneath arms
- neck behind jaw
- forehead and ears behind hair
- complete eyes behind lids

**Every moving layer needs 10-20% extra painted area beyond the visible seam.** This is what makes deformation (bending an arm, blinking an eye) not reveal a hard edge of unpainted canvas — skipping it is the single most common way a "finished" rig looks broken the moment it moves.

## What to check before claiming a PSD is spec-compliant

1. Every layer name in the actual PSD matches the tree above exactly (case-sensitive, snake_case).
2. Every layer listed under `mouth` exists as a distinct paintable layer, not baked into one.
3. Hidden-geometry areas are actually painted (visually inspect after a test deformation, not just assumed from the layer existing).
4. Canvas size is identical across every exported PNG derived from this PSD (a Rive import step will misalign parts otherwise).
5. Background is transparent, not white or a flattened matte.

None of this can be verified by reading text — it requires opening the actual PSD (or its PNG exports) in an image tool. State plainly when this hasn't been done rather than assuming compliance from the spec alone.
