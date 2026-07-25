# Visual Events Contract

This is the **real, production** event schema — the thing a Rive adapter must actually consume. Source: `src/visual/visualProtocol.js` and `src/visual/visualOrchestrator.js`, quoted/derived verbatim as of 2026-07-25. Do not confuse this with `tools/WineMD-Character-SDK/06_winemd/VISUAL_EVENTS.md`, which describes a simplified, aspirational `SommelierEvent`-shaped example — see the "Two different schemas" section below.

## Envelope (every event)

Constructed only via `createVisualEvent()` in `visualProtocol.js`; every event has:
- `type` — one of the 11 `VISUAL_EVENT_TYPES` (see below)
- `protocolVersion` — always `1` currently
- `generationId` — must pass `isSafeIdentifier` (`/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/`)
- `sequence` — positive safe integer, monotonically increasing per generation
- ...event-specific payload fields
- **never** an `html` field — explicitly rejected (`visual_html_forbidden`)

## Event types and payloads (as actually emitted by `visualOrchestrator.js`)

- **`visual.reset`** — `{ transition: 'soft', reason: 'new_generation' | 'generation_cancelled' }`
- **`visual.avatar.state`** — `{ state, speechAmplitude, mouthOpen, emotion, gesture, intensity }`. `state` ∈ `AVATAR_STATES`. Observed real combinations (see `state-machine-contract.md` for the full mapping-gap discussion):
  - `listening` / emotion `attentive` / intensity `0.55` (on `beginGeneration`)
  - `thinking` / emotion `focused` / intensity `0.6` (on `markThinking`)
  - `speaking` / emotion `warm` / intensity `0.65` (on `onAudioStart`, before any phase)
  - `presenting_wine` / emotion `enthusiastic` / gesture `present_wine` / intensity `0.75` (WINE_REVEAL phase)
  - `pointing` / emotion `warm` / gesture `present_pairing` / intensity `0.7` (PAIRING phase)
  - `confirming_order` / emotion `helpful` / gesture `present_cta` / intensity `0.65` (COMMERCE phase, only if demo-available)
  - `idle` / emotion `satisfied` / intensity `0.4` (on `onAudioEnd`)
- **`visual.wine.show`** — `{ wineId, presentation: 'hero', assetSetId, asset: assetSet, label: { name, winery, vintage } }`
- **`visual.wine.hide`** — (payload not observed in current orchestrator calls; type is reserved in the protocol)
- **`visual.aromas.show`** — `{ wineId, descriptors: aromas }` — **no accompanying `visual.avatar.state` gesture change**, see `architecture.md`
- **`visual.pairing.show`** — `{ wineId, pairings }`
- **`visual.region.show`** — `{ wineId, region }` (only if `region` is truthy)
- **`visual.card.show`** — `{ wineId, card: { name, winery, vintage, region, grapes, servingTemperature, alcohol, shortDescription } }`
- **`visual.commerce.show`** — `{ wineId, commerce: { productId, orderUrl, qrUrl, availability, price, currency } }` (only if `commerce.availability === 'demo_available'` and `orderUrl` present)
- **`visual.timeline.complete`** — `{ wineId, keepFinalCard: true }` (on `onAudioEnd`)
- **`visual.timeline.cancel`** — `{ reason }` (truncated to 80 chars)

## Two different schemas — do not conflate them

1. **This real schema** (above) is what `src/visual/*` actually emits and what `public/visual/VisualStoryController.mjs` actually consumes today.
2. **`tools/WineMD-Character-SDK/06_winemd/VISUAL_EVENTS.md`** describes a *different*, simplified shape aimed at `SommelierEvent`:
   ```json
   {"generationId":"answer-123","mode":"speaking","gesture":"presentAroma","emotion":"warm"}
   ```
   This is **not** what the real orchestrator emits — it's the SDK author's sketch of what a translated event *should* look like on the other side of an adapter that doesn't exist yet. Note it also never demonstrates the `mouth`/`blink` fields that `SommelierEvent` (`types.ts`) declares as valid optional fields — an incompleteness to be aware of, not a contradiction to silently "fix" by inventing values.

## What a Rive adapter must do

Subscribe to the real `visual.*` stream (same subscription point `VisualStoryController.mjs` uses), translate `visual.avatar.state` (primarily) into `SommelierEvent` shape using the mapping table in `state-machine-contract.md` (which has explicit, named gaps — do not silently invent values to fill them), and call `SommelierController.apply(event)`. On `visual.reset`/`visual.timeline.cancel`/generation end, call `SommelierController.endGeneration(id)`.
