# Architecture

Verified against the actual repository on 2026-07-25. Re-verify before relying on this if significant time has passed or the referenced files show different line counts/content than quoted here.

## The three layers that already exist and work (not Rive-specific)

1. **`src/realtime/realtimeServer.js`** — the turn/generation lifecycle. Every realtime connection creates one `visualOrchestrator` (`const { createVisualOrchestrator } = require('../visual/visualOrchestrator');` then `createVisualOrchestrator({ emit, log })` per connection). The orchestrator is driven directly from turn-lifecycle calls:
   - `visualOrchestrator.beginGeneration({ generationId, turnId, inputText })` — on `startInput`
   - `.noteUserText(generationId, text)` — on `transcript.user`
   - `.markThinking(generationId)` — on `endInput` / `submitTextInput`
   - `.onAudioStart(generationId)` / `.onAudioEnd(generationId)` — on provider audio events
   - `.cancel(generationId, reason)` — on `response.failed` / `response.cancelled` / explicit cancel
   - `.getState()` — inspect current orchestrator state

   `generationId` format: `` `${prefix}_${crypto.randomBytes(8).toString('hex')}` ``, created once per turn by `createGeneration({ turnId })`. Status cycles `pending → active → completed|cancelled|failed`. **A stale `generationId` must never be allowed to affect a newer turn** — every consumer downstream (including any Rive adapter) must check this.

2. **`src/visual/visualProtocol.js`** — the wire format. Exports:
   - `PROTOCOL_VERSION = 1`
   - `VISUAL_EVENT_TYPES` (Set): `visual.reset`, `visual.avatar.state`, `visual.wine.show`, `visual.wine.hide`, `visual.aromas.show`, `visual.pairing.show`, `visual.region.show`, `visual.card.show`, `visual.commerce.show`, `visual.timeline.complete`, `visual.timeline.cancel`
   - `AVATAR_STATES` (Set): `idle`, `greeting`, `listening`, `thinking`, `speaking`, `enthusiastic`, `presenting_wine`, `pointing`, `confirming_order`, `goodbye`
   - `createVisualEvent({ type, generationId, sequence, ...payload })` — the only legal way to construct an event; throws on missing/invalid fields (`assertVisualEvent`). Explicitly forbids an `html` field (`visual_html_forbidden`) — never add one.
   - `isSafeIdentifier(value)` — `/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/`

3. **`src/visual/visualOrchestrator.js`** — turns turn-lifecycle calls into a timed sequence of `visual.*` events. Key facts an adapter must respect:
   - `PHASE_DELAYS_MS`: `AROMAS: 850`, `PAIRING: 1750`, `REGION: 2500`, `SUMMARY: 3250`, `COMMERCE: 4050` (all relative to `onAudioStart`).
   - `createPlan()` explicitly has **no blind fallback wine** — if the turn isn't confidently about a specific wine (`chooseWineId(inputText)` returns falsy), no wine card phases run at all; this is an intentional avatar-only-response path, not a bug.
   - **Only these `avatarState()` calls exist today** — every other declared `AVATAR_STATES` value (`greeting`, `enthusiastic`, `goodbye`) is valid per the protocol but **never actually emitted** by current logic:
     - `beginGeneration` → `avatarState('listening', { emotion: 'attentive', intensity: 0.55 })`
     - `markThinking` → `avatarState('thinking', { emotion: 'focused', intensity: 0.6 })`
     - `onAudioStart` → `avatarState('speaking', { emotion: 'warm', intensity: 0.65 })`, then `runPhase(WINE_REVEAL)` → `avatarState('presenting_wine', { emotion: 'enthusiastic', gesture: 'present_wine', intensity: 0.75 })`
     - `runPhase(PAIRING)` → `avatarState('pointing', { emotion: 'warm', gesture: 'present_pairing', intensity: 0.7 })`
     - `runPhase(COMMERCE)` (only if `commerce.availability === 'demo_available'`) → `avatarState('confirming_order', { emotion: 'helpful', gesture: 'present_cta', intensity: 0.65 })`
     - `onAudioEnd` → `avatarState('idle', { emotion: 'satisfied', intensity: 0.4 })`
   - **`runPhase('AROMAS')` never calls `avatarState()` at all** — it only emits `visual.aromas.show`, with no accompanying gesture change. Do not assume a `presentAroma`-equivalent gesture currently fires anywhere in production; if Phase 2 wants one, it must be added to `visualOrchestrator.js` first (a real, scoped change to propose, not assume already exists).
   - The `gesture` field's actual observed values today are **snake_case**: `present_wine`, `present_pairing`, `present_cta`, and the default `none`. This does not match the SDK's camelCase `SommelierGesture` values (`presentWine`, `presentAroma`, `presentFood`) — see `references/troubleshooting.md` for the full casing/vocabulary mismatch and how to bridge it.

## The existing non-Rive renderer (do not duplicate)

`public/visual/VisualStoryController.mjs` (488 lines) is a complete, shipped, vanilla-JS/DOM consumer of the exact same `visual.*` stream:
- Duplicates `VISUAL_TYPES` and `PROTOCOL_VERSION` client-side for validation.
- `VisualEventGate` class mirrors server-side ordering/staleness protection (rejects `invalid_protocol`, `invalid_correlation`, `cancelled_generation`, `stale_generation`, `duplicate_or_out_of_order`).
- Renders a static PNG avatar (`/visual-assets/avatar-woman-1.png`) with a CSS `--mouth-open` custom property driven by Web Audio `AnalyserNode` RMS amplitude — this is CSS transform/opacity, not a skeletal rig.
- Handles all 11 event types, multi-language copy tables (en/ru/ro/fr/it/es/de/zh/ja).

A Rive character is a **second renderer for the same contract** — it should be swappable with `VisualStoryController.mjs`, not a replacement that changes the event contract, and definitely not something that lives alongside it fighting over the same DOM/state.

## Where Rive fits

```
visualOrchestrator (unchanged)
    -> visual.* events (unchanged schema)
    -> [NEW] a thin adapter, vanilla JS, analogous in style to VisualStoryController.mjs,
       that translates visual.avatar.state (and other visual.* events as needed)
       into SommelierEvent shape
    -> SommelierController.apply(event)  (tools/WineMD-Character-SDK/05_runtime/src/SommelierController.ts)
    -> Rive state machine inputs (mode / gesture / mouth / blink / emotion)
```

The adapter step (translating real `visual.avatar.state` fields into `SommelierEvent`) **does not exist yet** — `06_winemd/INTEGRATION_PLAN.md` step 4 names it but no file implements it. Building this mapping honestly (including the gaps noted above) is real, necessary work for this skill — do not claim it already exists.

## Framework constraint

This app has **no React, no Next.js, no bundler** anywhere in `package.json` dependencies or the actual source tree (confirmed: no `.jsx`/`.tsx` files exist). `start`/`dev` are both literally `node src/server.js`. Any Rive integration code must be plain JS/`.mjs`, loaded the same way `public/visual/VisualStoryController.mjs` is — never introduce React, Next.js, or a bundler step to make Rive "easier" to wire up. The official Rive web runtime (`@rive-app/canvas` or similar) works fine loaded directly as a script/module; that is the only new runtime dependency this should need.
