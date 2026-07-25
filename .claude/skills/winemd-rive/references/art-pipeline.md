# Art Pipeline

Source of truth: `tools/WineMD-Character-SDK/01_art_pipeline/` and `00_reference/`. Read those files directly — this is a summary, not a replacement.

## What's real today (verified by file size + content, 2026-07-25)

- `00_reference/master_character_source.png` — 2,287,611 bytes (~2.2 MB). Large enough to be genuine flattened character art, not a placeholder.
- `00_reference/master_character_cutout_approx.png` — 2,109,770 bytes (~2.1 MB). Same — genuine, approximate cutout of the master art.
- `01_art_pipeline/layer_map.png` — 1,284,577 bytes (~1.25 MB). Genuine annotated layer-map image.

None of these are placeholders. But **none of them is a layered PSD, and none of them is rigged**. They are reference material for a human artist/agent to work from when producing the real layered PSD — do not treat "the reference PNG exists" as "the PSD exists."

## Master-art requirements (`ART_REQUIREMENTS_RU.md`, verbatim, Russian original)

- Frontal view.
- Character shown from the waist up.
- Arms spread apart, not crossing.
- A visible gap between the arms and the torso.
- Hands fully visible (not cut off or overlapping other elements).
- Hair does not cover the eyes or touch the shoulders.
- Stand/counter, bottle, and wine glass are **separate** assets from the character.
- Transparent background.
- Hidden parts are fully painted in (see `HIDDEN_GEOMETRY.md`, quoted in `psd-layer-contract.md`).
- Master file character height: **at least 2500 px**.

## Export rules (`EXPORT_RULES.md`, verbatim)

- PSD, RGB, transparent background.
- Each deformable part on its own layer.
- PNG exports: RGBA, identical canvas size across all exports, no trimming.
- SVG only for clean vector props (matches `08_assets/*.svg` — bottle, glass, counter icons already present as simple vector placeholders, not final art).
- Use the snake_case layer names from the specification (see `psd-layer-contract.md` for the exact tree).

## What still needs to be produced (human/artist work, not something to fabricate)

1. A genuine layered PSD following the exact layer tree in `references/psd-layer-contract.md`, built from the master art above.
2. Hidden-geometry repaints for every part that moves (see `HIDDEN_GEOMETRY.md` rules — 10-20% extra painted area past the visible seam, minimum).
3. Final vector or painted versions of the counter/bottle/glass props if the current `08_assets/*.svg` placeholders aren't the final art.

**Do not generate a fake multi-layer PSD from the flattened reference PNG.** If asked to "prepare the PSD," the deliverable this skill can honestly produce is the verified layer-tree spec + a checklist for whoever does the Photoshop work (human or an image-generation-capable agent with real layer separation capability) — not a PSD file conjured from a flat image.
