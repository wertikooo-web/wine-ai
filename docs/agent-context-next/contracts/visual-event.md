# contracts/visual-event.md — Visual event protocol

## Event structure

```js
{
  type: string,           // one of VISUAL_EVENT_TYPES
  protocolVersion: 1,     // currently 1
  generationId: string,   // scoped to a specific turn/generation
  sequence: number,       // monotonically increasing integer (per generation)
  ...payload              // event-specific fields
}
```

## Event types

| Event Type | Payload | Description |
|---|---|---|
| `visual.reset` | `{ transition: 'soft' \| 'hard', reason: string }` | Clear all visuals |
| `visual.avatar.state` | `{ state, speechAmplitude, mouthOpen, emotion, gesture, intensity }` | Avatar state change |
| `visual.wine.show` | `{ wineId, presentation, assetSetId, asset, label }` | Show wine card |
| `visual.wine.hide` | `{ wineId }` | Hide wine card |
| `visual.aromas.show` | `{ wineId, descriptors }` | Show aroma descriptors |
| `visual.pairing.show` | `{ wineId, pairings }` | Show food pairings |
| `visual.region.show` | `{ wineId, region }` | Show region info |
| `visual.card.show` | `{ wineId, card }` | Show full wine card |
| `visual.commerce.show` | `{ wineId, commerce }` | Show commerce CTA |
| `visual.timeline.complete` | `{ wineId, keepFinalCard }` | Timeline finished |
| `visual.timeline.cancel` | `{ reason }` | Timeline cancelled |

## Avatar states

```text
idle, greeting, listening, thinking, speaking,
enthusiastic, presenting_wine, pointing, confirming_order, goodbye
```

Avatar state parameters:
- `speechAmplitude` — number (0-1)
- `mouthOpen` — number (0-1)
- `emotion` — string (neutral, attentive, focused, warm, enthusiastic, helpful, satisfied)
- `gesture` — string (none, present_wine, present_pairing, present_cta)
- `intensity` — number (0-1)

## Validation rules

```js
assertVisualEvent(event) {
  // Must be object
  // type must be in VISUAL_EVENT_TYPES
  // protocolVersion must be 1
  // generationId must be safe identifier (alphanumeric + . _ : -)
  // sequence must be positive integer
  // html field is FORBIDDEN (XSS prevention)
}
```

## Generation scoping

- All events carry `generationId`
- A stale event (different `generationId`) must never affect a newer generation
- `sequence` is monotonically increasing per generation
- Renderer must ignore events with unknown `generationId`

## Renderer contract

Two renderers consume the same events:
1. `public/visual/VisualStoryController.mjs` — DOM/CSS renderer
2. Rive character renderer — planned, not yet built

Both must:
- Validate event structure before processing
- Ignore events with stale `generationId`
- Handle `visual.reset` by clearing all state
- Handle `visual.timeline.cancel` by stopping animations
- Never execute `html` field content (XSS prevention)

## Tests

- `tests/visualProtocol.test.js` — event validation, type checking
- `tests/visualOrchestrator.test.js` — event emission, phase scheduling
- `tests/visualRealtime.test.js` — visual events in realtime session context
- `tests/visualIntentGate.test.js` — intent gating, trust validation
