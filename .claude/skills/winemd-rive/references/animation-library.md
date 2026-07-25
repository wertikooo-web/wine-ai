# Animation Library

Source of truth: `tools/WineMD-Character-SDK/04_animation_library/ANIMATIONS.md` and `TIMING.md`. Quoted verbatim as of 2026-07-25.

## Descriptions (`ANIMATIONS.md`, verbatim)

- **Idle** — 4-6 s seamless loop: breathing, tiny head drift, random blink.
- **Listening** — subtle head inclination and attentive focus.
- **Thinking** — brief eye shift and pause, 1.2-2 s.
- **Speaking** — small head and shoulder accents; mouth driven independently (not baked into this clip).
- **Welcome** — open both hands slightly and return.
- **Present Wine** — use the hand nearest the wine card.
- **Present Aroma** — open palm toward aroma constellation.
- **Present Food** — open palm toward pairing cards.
- **Goodbye** — warm smile, small nod, return to neutral.

## Timing (`TIMING.md`, verbatim)

```
Idle: 5 s
Blink: 0.12 s
Listening transition: 0.25 s
Thinking: 1.5 s
Speaking transition: 0.15 s
Presentation gestures: 1.0-1.4 s
Goodbye: 1.2 s
```

Use eased curves throughout. **No bounce** — this is a calm, professional sommelier character, not a cartoon mascot. Combine with `references/rive-rig-contract.md`'s movement-range constraints (small rotations, subtle breathing) when actually animating in Rive — timing alone doesn't guarantee the right feel if the movement ranges are too large.

## Cross-reference with required animations

`rive_manifest.json`'s `requiredAnimations` (`references/rive-rig-contract.md`) lists exactly: `idle, listening, thinking, speaking, welcome, present_wine, present_aroma, present_food, goodbye, blink, smile`. Every one of those except `smile` has a description above. `smile` has no description here either — it only appears in the manifest's required list. Combined with the state-machine gap noted in `rive-rig-contract.md` and `troubleshooting.md`, treat `smile` as unresolved spec debt, not something to silently animate to "complete the list."

## Phase mapping (from `SKILL.md`'s MVP order)

| Phase | Animations needed |
|---|---|
| 1 | idle, blink, speaking, present_wine (+ mouth shapes neutral/A/E/O/MBP, from `psd-layer-contract.md`) |
| 2 | listening, thinking, welcome, present_aroma, present_food, goodbye |
| 3 | none new here — Phase 3 items (emotion states, gaze targeting, audio-driven mouth, layout-aware gestures) are refinements of Phase 1/2 animations, not new named clips |
