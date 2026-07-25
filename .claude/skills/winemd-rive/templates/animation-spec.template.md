# Animation Spec: <name>

> Template. Fill in every field with verified values (checked against `references/animation-library.md` and `references/rive-rig-contract.md`), not assumptions. Delete this note when done.

- **Phase**: 1 / 2 / 3 (see `SKILL.md`'s MVP order)
- **Trigger condition**: which real event/state causes this to play — quote the exact `visual.*` event/state field from `references/visual-events-contract.md`, or state plainly "not yet wired to a real trigger"
- **Duration**: (from `references/animation-library.md`'s `TIMING.md` values, or a justified deviation)
- **Loop**: yes/no
- **Easing**: (no bounce, per spec)
- **Bones/layers involved**: (list from `references/rive-rig-contract.md` / `references/psd-layer-contract.md`)
- **Movement range check**: confirm every rotation/movement stays within `references/rive-rig-contract.md`'s constraints (head ±6°, shoulder max 18°, etc.) — list the actual values used, don't just assert compliance
- **Description**: (what it should look like — reference `references/animation-library.md`'s prose description as the baseline, note any deviation and why)
- **Verified in Rive editor?**: yes/no — if no, this spec is a plan, not a confirmed asset
- **Verified against a real turn through `realtimeServer.js`?**: yes/no
