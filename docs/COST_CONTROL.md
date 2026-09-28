# Cost & Usage Control

Dashboard tab **Расходы / Cost Control** shows what the WINE AI installation
consumes: conversations, conversation time, provider/model usage, MDL/EUR
cost (today, 7 days, calendar month in `Europe/Chisinau`), average cost per
conversation, breakdowns, manual fixed costs, monthly budget and projection.

## Architecture

```text
provider adapter ──onUsage(raw usage)──► sessionUsageMeter (one per WS session)
realtimeServer   ──turns / audio bytes─►        │ finalize() once, in closeProvider()
                                                ▼
other AI calls ──recordApiCall()──► costTelemetry (fire-and-forget, never throws)
                                                ▼
                                   costStore (Postgres ai_usage_records …)
                                                ▼
             /api/cost/* ◄── costAggregation (re-prices raw usage on read)
```

- `src/cost/pricing.js` — the only place prices are applied; versioned rows with `effective_from`/`effective_to`.
- `src/cost/usageNormalize.js` — provider payload → normalized usage.
- `src/cost/sessionUsageMeter.js` — per-session accumulation across provider rotations; idempotent finalize.
- `src/cost/costTelemetry.js` — fire-and-forget persistence; failures are logged and swallowed.
- `src/cost/costStore.js` — idempotent schema + Postgres/in-memory backends.
- `src/cost/costAggregation.js` — pure aggregation (periods, projection, budget, breakdowns).
- `src/cost/costApi.js` — `/api/cost/{summary,sessions,breakdown,pricing,fixed-costs,settings,customer-summary}`.
- `public/cost-control.js` — the Dashboard tab.

Budget is **observability only**: nothing in the realtime path reads it.

## Database (idempotent, created at boot and lazily on first write)

`ai_usage_records` (PK `record_id` = `rt:<session_id>` or `api:<uuid>`; inserts are
`ON CONFLICT DO NOTHING`, so duplicate finalization cannot double count; stores
normalized `usage`, raw provider payloads in `usage_raw`, and the pricing id and
cost at write time for audit), `ai_pricing`, `cost_fixed_items`, `cost_settings`.
Separate from the KOS migration transaction on purpose.

## What is ACTUAL vs ESTIMATED vs MANUAL

| Source | Usage data | Label |
| --- | --- | --- |
| Gemini Live (`LiveServerMessage.usageMetadata`: prompt/response token counts with per-modality details) | tokens by TEXT/AUDIO modality, summed over all usage messages of all provider instances in the session | ACTUAL (cost = tokens × pricing table). ESTIMATED if the provider did not itemize modality, or if no usage message arrived (then measured audio seconds × `audio_tokens_per_second`). |
| Grok/xAI realtime (`response.done` → `response.usage`, if sent) | tokens persisted raw for audit | xAI bills per audio minute; minutes are measured locally from session time → always ESTIMATED |
| `generateContent` calls (answerability, grounding, OCR, TTS preview, text evaluation) | `usageMetadata` | ACTUAL |
| Grounding with Google Search | 1 request per grounded call | ACTUAL count; list price ignores the free daily allowance (upper bound) |
| Embeddings (`embedContent`) | API returns no token count → characters | ESTIMATED (chars ÷ `chars_per_token`) |
| Fixed monthly costs | entered in the Dashboard | MANUAL |

"ACTUAL" means the usage units come from the provider; money is always
calculated from the pricing table (list prices), not from an invoice.
Models without a pricing row are shown as **UNPRICED**, never guessed.

Known limits: Gemini usage that arrives after a provider instance was
rotated/closed is not received; cached-token discounts are not modelled;
exchange rates are configuration (confirm them in the tab).
