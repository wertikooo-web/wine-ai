# Admin authentication (beta, before public `/lite`)

> Since the closed beta, the `/lite` runtime routes marked public below need a
> temporary guest access code (or an admin session): see `docs/LITE_ACCESS.md`.

```
Public user → /lite → no login
Admin → protected route → /login → password → server-side session cookie → Dashboard / admin APIs
```

One shared admin account for the beta (`ADMIN_USERNAME` / `ADMIN_PASSWORD`).
All checks are server-side, in one gate (`src/security/adminAuth.js`,
`classifyRoute()`), applied at the top of `handleRequest` in `src/server.js`
before any route runs. **Default for `/api/*` is admin** (deny by default);
public API endpoints are an explicit allow-list. Knowing a URL gives nothing:
an admin page without a session is a redirect to `/login`, an admin API is
`401`.

Sessions are server-side (in-memory, one Railway instance), random 256-bit
id in an `HttpOnly`, `SameSite=Lax`, `Secure` (production) cookie, 12 h
expiry, invalidated on logout. Failed logins are rate-limited per client IP.
Admin pages and admin API responses are `Cache-Control: no-store`.

## Route matrix

| Route | Method | Access | Reason |
|---|---|---|---|
| `/lite` | GET | public | QR / participant entry |
| `/api/lite/config` | GET | public | persona name/avatar, session limit, idle timeout and the operator's start intents (label / opening line / context — the same user-facing data the Lite client already sends over WS) for `/lite` and the widget. No persona prompts, provider config or keys |
| `/wine-ai-widget.js`, `/lite-companion.js` | GET | public | widget loader / Lite card renderer |
| `/cost-control.js`, `/live-test-control.js` | GET | public | static UI code only; every call they make hits admin APIs |
| `/persona-assets/:file`, `/persona-avatar/:id` | GET | public | avatar images |
| `/visual-assets/*`, `/visual-modules/*.mjs`, `/avatar-modules/*.mjs`, `/vendor/three/*`, `/avatar.png`, `*.png`, `/avatar-demo-*.wav` | GET | public | static assets used by `/lite` |
| `/visual-modules/debug/*` + Rive debug modules | GET | admin | debug harness (also env-gated) |
| `/api/age-verification` | GET, POST | public | 18+ gate for `/lite` |
| `/api/companion/catalog` | GET | public | published wine match names (Lite cards) |
| `/api/companion/wines/:cw_id` | GET | public | one published card with verified CTAs |
| `/api/live-test/feedback` | POST | public | participant rating from `/lite` |
| `/api/analytics/session-end`, `/api/analytics/purchase-click` | POST | public | anonymous client analytics |
| `/health` | GET | public | Railway / smoke health |
| `/login` | GET, POST | public | login form / credential check |
| `/logout` | POST | public | ends the session (no-op without one) |
| `/realtime` | WS upgrade | public | voice for `/lite` (18+ gate unchanged). Prompt debug (`include_prompt_debug`) is **admin-only** |
| `/`, `/dashboard`, `/dashboard/cost-guide` | GET | admin | dashboard |
| `/knowledge-studio`, `/answer-audit`, `/audit` | GET | admin | knowledge tools |
| `/avatar-lab`, `/avatar-dev` | GET | admin | avatar tools |
| `/api/persona`, `/api/persona/profiles` | GET | admin | exposes prompts / provider config |
| `/api/persona`, `/api/persona/activate`, `/api/persona/preview` | POST | admin | changes persona / provider / voice / limits |
| `/api/voices` | GET | admin | provider voice config |
| `/api/voice-preview` | POST | admin | paid TTS |
| `/api/live-test/state`, `/results` | GET | admin | test configuration and results |
| `/api/live-test/publish`, `/presets/:slot`, `/baseline` | POST | admin | changes what participants get |
| `/api/companion/wines` | GET | admin | full catalog incl. unpublished |
| `/api/companion/wines`, `/wines/import`, `/wines/:id/published` | POST | admin | catalog writes |
| `/api/cost/*` | all | admin | costs, pricing, fixed costs, web-search switch |
| `/api/knowledge/*` (status, sources, search-mode, evaluate, orchestrate, audit, benchmark, upload, reindex, update, discovered, pipeline-status, answer-modes) | all | admin | knowledge content, paid LLM calls, ingestion, reindex, publishing |
| `/api/knowledge/sources/:file` | GET, PATCH, DELETE | admin | source content / edit / delete |
| `/api/kos/*` (sources, crawl, documents, wines, extract, publish) | all | admin | ingestion and publishing |
| `/api/catalog/status`, `/api/avatar/status`, `/api/avatar/config` | GET | admin | internal status |
| `/api/screen-context/:type/:id`, `/api/purchase-options/:wineId` | GET | admin | dashboard visual demo (not used by `/lite`) |
| any other `/api/*` | any | admin | deny by default |

`/lite` shares `dashboard.html`; in Lite mode the page no longer calls any
admin API (persona, voices, knowledge, KOS, avatar status, screen-context /
purchase-options demo, Live Test / Cost panels, start-intent persistence).
The session limit, idle timeout and start intents it needs come from
`/api/lite/config`.

## Production smoke

`.github/workflows/production-smoke.yml` checks anonymously that every admin
page redirects to `/login` (`no-store`), admin APIs return `401`, and public
routes return `200`. The deep admin checks (knowledge chunks, Cost Control,
Live Test) run only when the GitHub secret `ADMIN_TOKEN` is set to the same
value as `ADMIN_TOKEN` in Railway; otherwise they are skipped.

## Railway environment variables

| Variable | Required | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | **yes (production)** | shared admin password. Without it, production fails closed: admin routes are unavailable, `/lite` works |
| `ADMIN_USERNAME` | no (default `admin`) | shared admin login |
| `ADMIN_SESSION_TTL_HOURS` | no (default 12) | session lifetime |
| `ADMIN_TOKEN` | no | header `x-admin-token` for scripts / CI (unchanged) |

Local development without `ADMIN_PASSWORD` (and not on Railway) keeps admin
routes open, as before.

## Later (after Wine Day)

The session stores a `role` (`admin` today). Separate `OWNER` / `PARTNER`
users map to roles checked per route group, without changing the gate.
