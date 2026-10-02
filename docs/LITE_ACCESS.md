# Temporary guest access to WINE AI Lite (closed beta)

```
Operator: Dashboard → Settings → "Временный доступ к WINE AI Lite" → label + code + lifetime
Guest:    /lite → access screen (/lite/access) → code → guest session → the usual Lite
Expiry / revoke → protected calls answer 401 → back to the access screen
```

Code: `src/security/liteAccess.js` (service, store, access screen), routes in
`src/server.js`, WebSocket admission + session watch in
`src/realtime/realtimeServer.js`, Dashboard block `public/lite-access-control.js`,
page gate at the top of `public/dashboard.html` (runs on `/lite` only).

## Storage

PostgreSQL table `lite_access_codes` (created on first use):
`id, label, code_hash, created_at, expires_at, revoked_at, last_used_at,
use_count, created_by, meta`. Codes are stored only as salted scrypt hashes
(Node `crypto`); the plaintext is returned once, at creation. Case and spaces
are ignored when a code is typed.

## Guest session

A correct code creates a signed session value `{grant id, expiry}` (HMAC;
key from `LITE_ACCESS_SECRET`, else derived from the admin credentials in
Railway, so sessions survive deploys). Session expiry = the code's expiry
(max 12 h). Transport:

- `wine_ai_lite` cookie: `HttpOnly`, `SameSite=Lax`, `Secure` in production;
- for the partner-site iframe (cross-site cookies do not travel; Safari
  blocks them) the same value in `sessionStorage`, sent as `x-lite-access`
  header / `la=` on the WebSocket URL. Never the code itself.

Every check re-reads the grant (5 s cache, dropped on revoke/delete):
expiry and revocation apply to open sessions too.

## Protected (guest session or admin)

| Route | Why |
|---|---|
| `/realtime?channel=lite` (WS upgrade) | voice / AI — the costly part |
| `GET /api/lite/config` | persona, limits, start intents |
| `GET, POST /api/age-verification` | 18+ gate of the Lite runtime |
| `GET /api/companion/catalog`, `/api/companion/wineries`, `/api/companion/wines/cw_*` | Visual Companion data |
| `POST /api/analytics/link-event`, `/api/analytics/session-end`, `/api/analytics/purchase-click`, `/api/live-test/feedback` | Lite analytics / rating |

Public: `/lite` (page code only; it shows nothing until the gate passes),
`/lite/access`, `GET/POST /api/lite/access`, static assets.
Admin only: `/api/lite-access/codes` (list, create), `/:id/revoke`, `DELETE /:id`.
A guest session is never an admin session.

## Open conversation when the code expires

Checked every 15 s (`LITE_ACCESS_CHECK_MS`). A reply in progress is not cut:
the close waits for the current generation (max 60 s), then uses the same
close path as the session-limit backstop (`session.ended` reason
`access_expired`); the page returns to the access screen with
«Срок тестового доступа закончился.». The voice pipeline is unchanged.

## Brute force

`POST /api/lite/access`: 8 failures per client IP per 15 min → 429 with
`Retry-After` (`LITE_ACCESS_MAX_FAILURES`, `LITE_ACCESS_WINDOW_MS`), +400 ms
per failure. Wrong, expired and revoked codes get the same answer. Failed
attempts are logged with the IP only, never the code.

## Switches

- Enforced in production. `LITE_ACCESS_ENFORCED=0` in Railway reopens `/lite`
  (emergency rollback, no deploy needed beyond the env change).
- `LITE_ACCESS_ENFORCED=1` enforces it anywhere (tests).

## Later (not built)

`max_uses`, `max_minutes`, single-use codes, usage/cost per code: the table
has `meta`, and every Lite session already knows its grant id.
