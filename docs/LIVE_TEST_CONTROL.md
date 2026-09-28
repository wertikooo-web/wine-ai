# Live Test Control (closed beta)

Operator: **Dashboard → Live Test**. Participants: **one URL, `/lite`** (one QR for the whole test).

## How it works

- Edit the **draft** (provider, voice, persona, mood, response length, tone, expertise,
  conversation mode, knowledge). Nothing changes until **APPLY TO NEW SESSIONS**.
- Apply publishes a complete, server-validated config as a new **revision**
  (history keeps previous → new).
- Every new `/lite` conversation takes an **immutable snapshot** of the published revision
  when its connection opens. Running conversations are never changed.
- **Presets A–D** and **RESET TO BASELINE** only load into the draft; you still press Apply.
  "Сохранить" stores the current draft in a preset slot; "Сохранить черновик как baseline"
  stores the known-good config.
- The banner at the top of the Dashboard always shows `CURRENT LIVE CONFIG`, publish time
  and revision.
- Dashboard's own Talk tab keeps using the ordinary Settings, not Test Control.

## Before the meeting

1. Talk → Voice mode: **Free Conversation** (server-wide; `/lite` needs it — the banner warns).
2. Live Test: load a preset, check it, **APPLY TO NEW SESSIONS**.
3. Open `/lite` on a phone, have one short conversation, rate it, and check that it
   appears in "Последние сессии".

## Participant view (`/lite`)

One "Start conversation" button, the avatar and visual cards. No provider, model, voice id or
settings are shown. Each conversation ends with an optional rating (conversation 1–5,
voice 1–5, "what was bad?"), stored with the session and its config revision.

## Data

PostgreSQL tables: `live_test_state` (published / presets / baseline), `live_test_revisions`,
`live_test_sessions` (snapshot per session, language, end time), `live_test_feedback`.
Duration, turns and end reason come from `ai_usage_records` (Cost Control) by `session_id`.

Endpoints: `GET /api/live-test/state`, `GET /api/live-test/results`,
`POST /api/live-test/publish | /presets/:slot | /baseline` (x-admin-token when `ADMIN_TOKEN`
is set), `POST /api/live-test/feedback` (participants).

## Known limitations

- Voice mode (Free Conversation vs Hold to Talk) is server-wide Settings, not part of the
  snapshot (the realtime server reads it per session; changing that is voice-pipeline scope).
- Per-turn latency is not in the results table yet (no passive per-turn latency metric exists).
- Language is Auto (detected from speech); the snapshot records the detected language at the end.
