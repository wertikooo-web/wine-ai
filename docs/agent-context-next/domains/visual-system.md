# domains/visual-system.md — Visual orchestrator, events, and B-roll

## Trigger

When the task involves: visual events, wine cards, aromas, pairings, region display, avatar state changes, visual orchestrator, visual catalog, B-roll, Rive character.

## Core files

- `src/visual/visualProtocol.js` — event types, validation, `createVisualEvent()`
- `src/visual/visualOrchestrator.js` — event emission, phase scheduling, generation lifecycle
- `src/visual/visualIntentGate.js` — intent detection, trust gating
- `src/visual/visualCatalog.js` — wine knowledge catalog, `chooseWineId()`, `getValidatedPresentation()`
- `src/visual/visualAssetRegistry.js` — asset resolution (resolveAssetSet, resolveDescriptors, etc.)
- `public/visual/VisualStoryController.mjs` — DOM/CSS renderer (shipped, working)

## Key concepts

### Visual event protocol

Events are objects with:
- `type` — one of `VISUAL_EVENT_TYPES` (e.g. `visual.wine.show`, `visual.avatar.state`)
- `protocolVersion` — currently `1`
- `generationId` — scoped to a specific turn/generation
- `sequence` — monotonically increasing integer (per generation)

**Forbidden:** `html` field in visual events (XSS prevention).

### Visual event types

```text
visual.reset            — clear all visuals, transition to new state
visual.avatar.state     — avatar state change (idle, thinking, speaking, etc.)
visual.wine.show        — show wine card with label info
visual.wine.hide        — hide wine card
visual.aromas.show      — show aroma descriptors
visual.pairing.show     — show food pairings
visual.region.show      — show region map/info
visual.card.show        — show full wine card summary
visual.commerce.show    — show commerce CTA (order URL, QR, price)
visual.timeline.complete — timeline finished
visual.timeline.cancel  — timeline cancelled (interruption, barge-in)
```

### Avatar states

```text
idle, greeting, listening, thinking, speaking,
enthusiastic, presenting_wine, pointing, confirming_order, goodbye
```

Each state includes parameters: `speechAmplitude`, `mouthOpen`, `emotion`, `gesture`, `intensity`.

### Visual orchestrator lifecycle

```text
beginGeneration(generationId, turnId, inputText)
  → visual.reset (new_generation)
  → avatarState('listening')

markThinking(generationId)
  → avatarState('thinking')

onAudioStart(generationId)
  → createPlan() (chooseWineId → getValidatedPresentation)
  → avatarState('speaking')
  → runPhase('WINE_REVEAL')
  → schedulePhase('AROMAS', 850ms)
  → schedulePhase('PAIRING', 1750ms)
  → schedulePhase('REGION', 2500ms)
  → schedulePhase('SUMMARY', 3250ms)
  → schedulePhase('COMMERCE', 4050ms)

onAudioEnd(generationId)
  → clearTimers()
  → runPhase(AROMAS, PAIRING, REGION, SUMMARY, COMMERCE)
  → avatarState('idle')
  → visual.timeline.complete

cancel(generationId, reason)
  → clearTimers()
  → visual.timeline.cancel
  → visual.reset
```

### Phase delays

```js
PHASE_DELAYS_MS = {
    AROMAS: 850,
    PAIRING: 1750,
    REGION: 2500,
    SUMMARY: 3250,
    COMMERCE: 4050,
}
```

### Visual intent gate

Decides whether to show wine card based on:
- `intent.type` (general, follow_up, buy_wine)
- `intent.wineId` (must be published)
- `intent.evidenceSource` (must be trusted: tool_result, recommendation_engine, screen_context, active_context)
- `intent.confidence` (must be >= 0.75)
- `intent.commerce` (must have active status, available availability, valid price, valid orderUrl)

Decisions: `AVATAR_ONLY`, `SHOW_WINE`, `SHOW_WINE_WITH_COMMERCE`, `KEEP_CURRENT_WINE`, `CLEAR_VISUAL`.

### Visual catalog

- 3 demo wines: `demo-wine-001` (red), `demo-wine-002` (rosé), `demo-wine-003` (white)
- `chooseWineId(text)` — regex-based matching (not real intent resolution)
- `getValidatedPresentation(wineId)` — returns frozen knowledge + commerce + assetSet + aromas + pairings + region
- Gate before selection: requires specific wine name in text (not generic wine questions)

### Two renderers

1. `public/visual/VisualStoryController.mjs` — DOM/CSS renderer (shipped, working)
2. Rive character renderer — planned, not yet built (see `.claude/skills/winemd-rive/`)

Both consume the same `visual.*` events. No LLM provider ever touches visual events directly.

## Gotchas

- Visual events are scoped to `generation_id`. A stale event must never affect a newer generation.
- The orchestrator is the only thing that knows about turns/generations/interruption.
- `chooseWineId()` is a keyword heuristic, not real intent resolution — it only fires when a specific demo wine is named.
- Phase timers are cleared on `onAudioEnd()` and `cancel()` — no orphaned timers.
- `beginGeneration()` cancels any previous active generation (superseded).
- Demo wines are hardcoded — not from the knowledge base or KOS pipeline.

## Tests

- `tests/visualOrchestrator.test.js` — orchestrator lifecycle, phase scheduling
- `tests/visualProtocol.test.js` — event validation, type checking
- `tests/visualRealtime.test.js` — visual events in realtime session context
- `tests/visualIntentGate.test.js` — intent gating, trust validation
- `tests/visualClientGate.test.js` — client-side visual gate
