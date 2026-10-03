# Turn journal (`ai_turns`)

One row per assistant turn, written ~2.5 s after the turn ends (so the
provider's usage report, which arrives at turnComplete, is included).
Observation only: `src/observability/turnJournal.js` is fed by
`realtimeServer.js` at the existing turn end points (completed / failed /
timeout / cancelled / interrupted); writes are fire-and-forget and never
throw into the conversation.

| Column | Meaning |
|---|---|
| id | generation id |
| session_id, turn_id | conversation / turn |
| channel, provider, model, voice, language, mode | context (mode: tap_to_start, push_to_talk, text) |
| access_grant | Lite guest access code id (cost per code) |
| outcome, outcome_reason | completed, failed, timeout, cancelled, interrupted |
| question, answer | guest utterance and model answer (transcripts, ≤2000 chars) |
| tools | per tool call: name, ms, found, levels, web, answerable, evidence [{level, id, title, score, source}], screen_cards, shown_in_chat, error |
| usage | normalized provider tokens for the turn |
| cost_usd | list-price cost of the turn (src/cost/pricing.js) |
| first_audio_ms, total_ms | latency from turn start |
| flags | e.g. scripted_line, unverified_names (see below) |

Read: `GET /api/turns?from=&to=&session=&limit=` (admin) or the
`diagnostic=turns` workflow (`scripts/diag/turns.js`).

Env: `TURN_JOURNAL=off` (record nothing), `TURN_JOURNAL_TEXT=off` (no
question/answer text), `TURN_JOURNAL_RETENTION_DAYS=30` (older rows purged).

Privacy: question/answer may contain what a guest said (a name, a phone
number). Kept 30 days, admin-only; switch text off with
`TURN_JOURNAL_TEXT=off`.

## "Not from the catalog" flag

Before a row is written, proper names in the answer (capitalized phrases,
«quoted» names) are checked against the entity registry, Wine.md catalog
titles (`catalog_products`, cached 10 min), published companion wines, the
guest's question and the evidence titles the tools returned. Names most of
whose words are unknown go to `flags.unverified_names` (max 5);
`flags.name_check_without_catalog` marks a check made without the catalog.
Grapes, places, "Château"/"Reserve", the brand and the personas are ignored.

Heuristic: Cyrillic and Latin spellings are compared by a phonetic skeleton
(«Пуркарь» = Purcari). It prefers misses over false alarms. Review only —
nothing the guest hears changes.

Flagged turns only: `TURNS_FLAGGED=1 node scripts/diag/turns.js`. Switch off:
`TURN_JOURNAL_NAME_CHECK=off`.
