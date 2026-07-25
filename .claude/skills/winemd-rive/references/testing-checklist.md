# Testing Checklist

What "MVP verified" actually means — not "the files exist," but observed, working behavior. Run the validator scripts (`scripts/`) first; they catch structural problems cheaply. Everything below still needs human/visual confirmation that no script can automate.

## Phase 1 verification (Idle, Blink, Speaking, Present Wine, mouth shapes)

- [ ] `node scripts/validate-rive-manifest.mjs` passes
- [ ] `.riv` file loads in the actual Rive web runtime without console errors (open it in a real browser page, not just "the file exists")
- [ ] `SommelierSM` state machine is present in the loaded artboard with all Phase-1-relevant inputs (`mode`, `mouth`, `blink`) responding to `setNumber`/`fire` calls
- [ ] Idle loop plays seamlessly for at least 2-3 full cycles with no visible pop/jump at the loop point
- [ ] Blink fires correctly on the `blink` trigger, duration ~100-160 ms per `rive-rig-contract.md`
- [ ] Speaking animation plays while `mode = 3`, and stops/returns to idle when `mode` returns to 0
- [ ] Present Wine gesture triggers correctly when `gesture = presentWine` (or whatever real value maps to it per `state-machine-contract.md`), uses "the hand nearest the wine card" per `ANIMATIONS.md`
- [ ] Mouth shapes (`neutral`/`A`/`E`/`O`/`MBP`) are each visually distinct and don't clip/reveal unpainted hidden geometry when switching between them
- [ ] A live end-to-end test: trigger a real turn through `realtimeServer.js` (text or voice input), confirm the adapter receives `visual.avatar.state` events and the Rive character responds — not just a manually-constructed test event
- [ ] Interruption test: start a turn, interrupt it before completion, confirm `SommelierController.endGeneration()` fires and a **new** generation's events aren't ignored due to a stale `activeGenerationId` lock (this exact scenario has never been tested — see the caveat in `state-machine-contract.md`)

## Phase 2 verification (only after Phase 1 fully passes)

- [ ] Listening, Thinking transitions play at the correct trigger points in the real turn lifecycle (`beginGeneration`, `markThinking`)
- [ ] Welcome, Goodbye play at genuinely correct moments — note neither `greeting` nor `goodbye` `AVATAR_STATES` values are currently emitted by `visualOrchestrator.js` (see `architecture.md`); decide and implement when they should fire before testing this, since there's currently no trigger point in production code for either
- [ ] Present Aroma / Present Food: same caveat — no real orchestrator code emits a distinguishing gesture for the AROMAS phase today (see `architecture.md`); this needs a scoped, deliberate change to `visualOrchestrator.js`, not a silent assumption

## Phase 3 verification

- [ ] Emotion states visibly change character expression per the `emotion` input values already wired in Phase 1/2
- [ ] Gaze targeting tracks a real target (define what "target" means concretely — cursor position? a UI element? — before building)
- [ ] Audio-driven mouth animation goes beyond the simple neutral/A/MBP amplitude switch (MVP spec) — define the upgrade concretely (viseme detection? more amplitude buckets?) before building
- [ ] Layout-aware gestures behave correctly across the mobile/desktop/tabletop/kiosk responsive layouts from `runtime-integration.md`

## General discipline

- Never check a box above without having actually observed the behavior (in a browser, via the real runtime) this session or very recently. A green checklist from a past session doesn't carry forward automatically after code changes.
- If a script can't verify something (most of this list — visual/behavioral correctness isn't script-checkable), say so explicitly rather than letting an unchecked box quietly imply "passed."
