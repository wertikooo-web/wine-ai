# domains/security.md — Secrets, SSRF, deployment gates

## Trigger

When the task involves: SSRF protection, URL validation, secrets management, deployment security, authentication, authorization, environment variables.

## Core files

- `src/kos/sources/ssrfProtection.js` — SSRF protection for URL validation
- `src/kos/sources/robotsPolicy.js` — robots.txt compliance
- `src/server.js` — auth, route guards
- `.env.example` — environment variable documentation

## Key concepts

### SSRF protection

`validateUrlSsrf(rawUrl)` performs:
1. URL parsing and syntactic validation
2. Reject embedded credentials (`user:pass@`)
3. Restrict protocols to `http:` and `https:`
4. Restrict ports to 80 and 443
5. DNS A/AAAA resolution + validation of all resolved IPs
6. Block private/loopback/link-local/cloud metadata IPs
7. Block alternative IP notation (decimal, hex, octal)
8. Socket IP pinning to prevent TOCTOU DNS rebinding

Blocked hostnames: `localhost`, `localhost.localdomain`, `broadcasthost`
Blocked suffixes: `.internal`, `.local`, `.railway.internal`

### Robots policy

`parseRobotsTxt(robotsText, targetUserAgent)`:
- Parses robots.txt rules for `WINE-AI-KOS-Crawler/1.0`
- Returns `isAllowed(urlPath)` function and `sitemaps` list
- Longest-prefix matching for allow/disallow rules

### Secrets management

**Never print/store:**
- Full `.env` files
- API keys (`GEMINI_API_KEY`, `GROK_API_KEY`, `XAI_API_KEY`)
- Database connection strings (`DATABASE_URL`)
- S3 credentials (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`)
- OAuth tokens, cookies, authorization headers

**Environment variables (from `.env.example`):**
- `PORT` — server port (default 3200)
- `REALTIME_PROVIDER` — provider selection (mock/gemini/grok)
- `GEMINI_API_KEY` — Gemini API key
- `GROK_API_KEY` / `XAI_API_KEY` — Grok/xAI API key
- `DATABASE_URL` — PostgreSQL connection string
- `AVATAR_API_KEY` — Avatar API key
- `SAVE_AUDIO` — audio storage toggle (off by default)
- `S3_*` — object storage credentials

### Deployment security

- `railway up --detach` for production deployment
- GitHub auto-deploy connected via `railway service source connect`
- CI workflow (`startup-smoke`) runs on every push to main
- Deployment gates must pass before merge/deploy (see `INVARIANTS.md`)

### Authentication

- Admin auth module (`tests/startupNoAdminAuth.test.js` tests server without it)
- Route guards in `src/server.js`
- No approval/sandbox bypass modes unless explicitly requested

### Audio storage

- `SAVE_AUDIO=false` by default
- Requires explicit user consent to enable
- Stores raw session audio to disk for debugging

## Gotchas

- SSRF test mode (`NODE_ENV=test` or `KOS_TEST_MODE=true`) uses fallback IPs
- `isPrivateIp()` normalizes IPv4-mapped IPv6 (`::ffff:`)
- Alternative IP notation detection blocks decimal, hex, octal formats
- `robotsPolicy.js` defaults to `isAllowed: () => true` when no robots.txt
- `ssrfProtection.js` uses `dns.lookup()` as fallback when `resolve4`/`resolve6` fail (common on Windows/VPN)
- S3 credentials are optional (local storage when `KOS_STORAGE_PROVIDER=local`)

## Tests

- `tests/ssrfProtection.test.js` — SSRF validation, IP blocking, alternative notation
- `tests/robotsPolicy.test.js` — robots.txt parsing, allow/disallow rules
