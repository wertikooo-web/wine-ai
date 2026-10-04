# Runbook: voice provider down (Gemini credits / key)

## Signal

**Main alarm: external uptime monitor** (GitHub's schedule runs only every
3-5 hours in practice, too slow).

- URL: `https://wine-ai-realtime-production.up.railway.app/health/provider`
  (public; 200 = Gemini answers, 503 = credits/key/network problem; no error text).
- Set up once (free, ~2 min): UptimeRobot -> New monitor -> HTTP(s) -> that URL ->
  interval 5 min -> alert contact = your e-mail (and Telegram if you like).
- Polling is cheap: the server caches the check for 5 min (at most one 1-token
  Gemini call per 5 min).

Backup signals:

- E-mail from GitHub: **Provider Health** workflow failed. The log says why:
  - `probe quota`: Gemini prepaid credits are used up, or a quota/spend cap was hit.
  - `probe auth`: the API key is invalid or revoked.
  - `sessions: {"quota":N}`: real guests hit the error in the last 35 min.
- Manual check: Actions → Provider Health → Run workflow, or
  `GET /api/provider-health?probe=1` (admin).

Guests see this as: the avatar does not answer, or the conversation ends at once.

## Fix (5 minutes)

1. **Top up first.** Google AI Studio → Billing for the project that owns `GEMINI_API_KEY`
   → add credits (or raise the spend cap). The service recovers on its own; nothing to redeploy.
2. Re-run **Provider Health**. When it is green, you are done.

## If top-up is not possible right now: switch /lite to Grok

Only if `grok_configured: true` in the workflow log (Railway has `GROK_API_KEY` / `XAI_API_KEY`).

1. Dashboard → **Live Test** → load preset **C (Grok Warm)** → **APPLY TO NEW SESSIONS**.
2. Open `/lite` on a phone and have one short conversation.
3. Running conversations are not changed; new ones use Grok.

Limits of Grok mode: a different voice, and accent/quality have not been benchmarked
like Gemini's. Dashboard Talk is not switched (it uses ordinary Settings).

Back to Gemini after top-up: Live Test → **RESET TO BASELINE** (or preset A) →
**APPLY TO NEW SESSIONS**.

If `grok_configured: false`, you cannot switch. Top up Gemini; in the meantime tell
the guests that the service is paused.

## Notes

- The probe is one text call (`gemini-2.5-flash`, 1 output token) every 30 min. It uses the
  same key and billing as Gemini Live and costs effectively nothing.
- Make sure GitHub sends you failed-workflow e-mails: GitHub → Settings → Notifications →
  Actions → "Notify me for failed workflows only" (backup only: the schedule is slow).
- A successful live probe decides "usable now": session errors from before a top-up do not
  keep the alarm red.
- Switch the schedule off: Actions → Provider Health → ⋯ → Disable workflow.
