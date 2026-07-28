# Incident: Missing adminAuth module caused production outage

## Summary

Production deployment crashed immediately on startup due to `require('./auth/adminAuth')` in `src/server.js:37` referencing a file that was never committed to Git. The module (`src/auth/adminAuth.js`) existed only in the developer's local working tree. Every deployment from a clean Git checkout (including Railway) failed with `MODULE_NOT_FOUND`, taking production offline for approximately 3 hours.

## Impact

- **Duration:** ~3 hours (2026-07-26 23:37 — 2026-07-27 00:33, +0300)
- **Severity:** Complete production outage — all endpoints unreachable
- **Users affected:** All users of the Wine AI Realtime dashboard and voice interface
- **Data loss:** None
- **Downstream services:** None affected (this is the top-level service)

## Timeline

| Time (+0300) | Event |
|---|---|
| 2026-07-25 00:19 | `src/auth/adminAuth.js` created on developer's local machine (4959 bytes) |
| 2026-07-25 01:00 | Commit `d7344a9` introduces `require('./auth/adminAuth')` in `src/server.js` — file not staged |
| 2026-07-26 21:36 | Commit `b8b8748` (latest on main before fix) — server.js still contains the broken require |
| 2026-07-26 21:36 | Last successful production deployment `0179f1c1` (SUCCESS) — was `railway redeploy` of pre-existing container, not a fresh build |
| 2026-07-26 23:37 | `railway up --detach` from clean worktree triggers fresh build from `b8b8748` source → deployment `4476986a` |
| 2026-07-26 23:37 | Deployment `4476986a` enters crash loop: `Cannot find module './auth/adminAuth'` |
| 2026-07-26 23:50 | Repair commit `1efba7e` created in clean worktree (removes dead require + adds regression test) |
| 2026-07-27 00:13 | Repair commit pushed to `origin/main` |
| 2026-07-27 00:33 | Fresh deployment `4b2c2c85` from updated `origin/main` — **SUCCESS** |
| 2026-07-27 00:34 | Production health verified: all endpoints HTTP 200 |

## Detection

Detected via manual production check when endpoints returned 502 / connection timeout. No automated alerting or monitoring caught the crash loop.

## Root cause

**VERIFIED:** Commit `d7344a9` (2026-07-25 01:00:56) added `const { createAdminAuth } = require('./auth/adminAuth');` to `src/server.js` without staging or committing `src/auth/adminAuth.js`. The file existed on the developer's local machine (`src/auth/adminAuth.js`, 4959 bytes, created 2026-07-25 00:19) but was never added to Git.

The `createAdminAuth` function is imported but **never called** anywhere in the committed codebase. No routes, middleware, startup checks, dashboard code, or tests use it. It was an incomplete future feature (admin panel authorization) that was wired into the import block but never implemented.

Locally, the server started without error because `src/auth/adminAuth.js` existed on disk. In any clean Git checkout (fresh clone, CI, Railway build), the file does not exist → `MODULE_NOT_FOUND` crash.

## Contributing factors

### 1. No CI/CD pipeline

**VERIFIED:** No `.github/workflows/` directory exists. No CI checks run on push or PR. There is no automated startup test, no import validation, no build verification. Every deployment goes directly from local machine to Railway without any automated gate.

**LIKELY:** If a CI pipeline existed with a startup smoke test (`node src/server.js` + `/health` check), this outage would have been caught at commit time — before any deployment.

### 2. No pre-commit hooks

**VERIFIED:** No `.pre-commit-config.yaml`, no `husky`, no `lint-staged`, no Git hooks configured. The developer could commit `src/server.js` with a broken require and push directly to `main`.

### 3. Existing smoke tests run from dirty working tree

**VERIFIED:** `scripts/http-smoke.js` spawns `src/server.js` as a child process and checks endpoints. This test passes in the developer's environment because `src/auth/adminAuth.js` exists on disk. The smoke test does NOT verify that all required modules are committed — it only checks that the running server responds correctly.

**LIKELY:** A startup smoke test that runs from a clean `git checkout` (without untracked files) would have caught the missing module.

### 4. `railway redeploy` vs `railway up` behavior

**VERIFIED (from DEPLOYMENT.md):** `railway redeploy --yes` restarts the existing built container without rebuilding from the current `HEAD`. `SUCCESS` status only means "the container started", not "this is today's code". The last deployment before the outage (`0179f1c1`, SUCCESS at 21:36) was likely a `redeploy` of a pre-existing container that still had the working code.

**VERIFIED:** When `railway up --detach` was finally run from a clean worktree, Railway performed a fresh build from the uploaded source — which contained the broken require.

**UNKNOWN:** Why the first `railway up --detach` from a worktree with HEAD=1efba7e appeared to upload b8b8748 content. Possible explanations include Railway source indexing caching, race condition with rapid successive deploys, or timing issue with the upload capturing pre-repair state. This requires investigation with Railway support or detailed build log analysis.

### 5. Unused import not caught by any check

**VERIFIED:** `createAdminAuth` is imported but never called. No linter, no type checker, no dead-code analysis runs in this project. Node.js does not error on unused imports — it only errors when the module file itself is missing.

## Recovery

1. Identified root cause: `MODULE_NOT_FOUND ./auth/adminAuth` in Railway crash logs
2. Created clean worktree from commit `b8b8748`
3. Removed dead `require('./auth/adminAuth')` line from `src/server.js`
4. Added regression test `tests/startupNoAdminAuth.test.js`
5. Verified locally: server starts, `/health` returns 200, all endpoints work
6. Pushed repair commit `1efba7e` to `origin/main`
7. Created fresh clone from updated `origin/main`
8. Deployed via `railway up --detach` from fresh clone
9. Verified production: deployment `4b2c2c85` SUCCESS, all endpoints HTTP 200

## What went well

- Root cause was identified quickly from Railway crash logs
- Repair was minimal and surgical (1 line removed, 1 regression test added)
- Recovery process was methodical with verification at every step
- No data loss occurred
- No other services were affected
- The unused import meant no functionality was lost by removing it

## What went wrong

- An incomplete feature was committed with a runtime dependency on an untracked file
- No CI pipeline existed to catch the broken import before deployment
- No pre-commit hooks prevented the broken commit
- Existing smoke tests ran from the dirty working tree and could not detect the issue
- The outage lasted ~3 hours because recovery required manual intervention
- No automated alerting detected the crash loop

## Where we got lucky

- The unused import meant removing it had zero functional impact
- The repair commit was straightforward and low-risk
- The developer was available to diagnose and fix the issue manually
- No other features depended on the incomplete admin auth module
- The `createAdminAuth` function was never called, so there were no runtime side effects from the missing import beyond the crash itself

## Corrective actions

### P0 — Must do (prevents recurrence)

1. **Add CI startup smoke test** (see Preventive actions §1)
2. **Add missing-local-imports check** (see Preventive actions §2)

### P1 — Should do (reduces blast radius)

3. **Document deployment gate** (see Preventive actions §3)
4. **Add pre-commit hook for import validation** (optional, see Preventive actions §2)

### P2 — Nice to have (defense in depth)

5. **Add GitHub Actions CI pipeline** with lint, test, and startup smoke
6. **Add Railway deploy notification** (Slack/email on CRASHED status)

## Preventive actions

### 1. CI startup smoke test

**Goal:** Catch any `MODULE_NOT_FOUND` or startup crash before deployment.

**Implementation:** Add a GitHub Actions workflow (`.github/workflows/startup-smoke.yml`) that:

```yaml
name: Startup Smoke
on: [push, pull_request]
jobs:
  startup-smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - name: Start server and check /health
        run: |
          node src/server.js &
          SERVER_PID=$!
          for i in $(seq 1 15); do
            if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
              echo "Server healthy after ${i}s"
              kill $SERVER_PID 2>/dev/null
              exit 0
            fi
            sleep 1
          done
          echo "Server failed to start within 15s"
          kill $SERVER_PID 2>/dev/null
          exit 1
        env:
          PORT: 3000
          REALTIME_PROVIDER: mock
```

**Why this works:** Runs from a clean `git checkout` — no untracked files available. Any missing module causes immediate `MODULE_NOT_FOUND` crash, `curl` never succeeds, test fails.

**Limitations:** Does not test production environment variables or database connections. Those are tested by the existing smoke scripts and can be added to CI later.

### 2. Missing local imports check

**Goal:** Detect `require()` or `import` referencing files that exist on disk but are not tracked by Git.

**Recommended approach:** A lightweight shell script (not a dependency scanner):

```bash
#!/bin/bash
# scripts/check-missing-imports.sh
# Finds require('./...') in committed src/ files and verifies each target exists in Git.
# Does NOT follow dynamic requires, optional deps, or node_modules.

set -euo pipefail

MISSING=0
while IFS= read -r file; do
  while IFS= read -r req; do
    target=$(echo "$req" | sed "s/.*require(['\"]\.\/\(.*\)['\"]).*/\1/")
    # Resolve relative to the file's directory
    dir=$(dirname "$file")
    for ext in .js .json ""; do
      candidate="${dir}/${target}${ext}"
      if [ -f "$candidate" ]; then
        # File exists on disk — check if it's tracked by Git
        if ! git ls-files --error-unmatch "$candidate" > /dev/null 2>&1; then
          echo "UNTRACKED: $file requires $candidate (not in Git)"
          MISSING=1
        fi
        break
      fi
    done
  done < <(grep -oP "require\(['\"]\./[^'\"]+['\"]\)" "$file" 2>/dev/null || true)
done < <(git ls-files 'src/**/*.js')

exit $MISSING
```

**Limitations of static checking:**
- Cannot follow dynamic `require(variable)` patterns
- Cannot resolve optional dependencies (`try { require('optional-pkg') } catch {}`)
- Cannot handle platform-specific paths (`./binding/${platform}`)
- Cannot check generated files or postinstall scripts
- False positives on conditional requires behind feature flags

**Recommendation:** The startup smoke test (§1) is the primary gate. The static check (§2) is a supplementary fast-fail for obvious cases. Do not rely on static checking alone.

### 3. Deployment gate (documented process)

Before any `railway up` or production deployment, verify ALL of the following:

```markdown
## Pre-deploy checklist

1. **Clean working tree:** `git status --short` shows only intended changes
2. **Exact Git SHA:** document the commit being deployed
3. **SHA in origin/main:** `git rev-parse origin/main` matches the SHA
4. **Fresh checkout:** use a clean clone or worktree, not the dirty dev workspace
5. **Targeted tests pass:** run tests for changed modules only
6. **Startup smoke passes:** server starts from clean checkout, `/health` returns 200
7. **Railway target verified:** `railway status` shows correct project/service/environment
8. **Single deployment:** one `railway up --detach`, then wait for result
9. **Deployment ID captured:** record the new deployment ID before checking status
10. **Production health verified:** HTTP checks against production URL confirm the new deployment
```

### 4. Unfinished features policy

**Rule:** No committed code may have a mandatory `require()` or `import` for a module that:
- Does not exist in Git, OR
- Is marked as experimental/incomplete, OR
- Has not been tested in a clean checkout

**Implementation options (choose one):**
- **Feature flag pattern:** `const createAdminAuth = tryRequire('./auth/adminAuth')` where `tryRequire` returns `null` if the module is missing
- **Lazy require:** Only `require()` the module when the feature is actually invoked, not at startup
- **Complete or remove:** If a feature is committed, the module must be committed and tested. If it's not ready, the import must not be in committed code.

## Remaining risks

1. **No CI pipeline:** The project still has no automated checks. Any future broken commit will go undetected until deployment.
2. **Dirty working tree pattern:** The main workspace has 100+ untracked/modified files. Future deployments must continue to use fresh clones, not the dirty workspace.
3. **KOS_SCHEMA_DRIFT_DETECTED:** Pre-existing database migration checksum mismatch. Does not block startup or API reads, but indicates schema management needs attention.
4. **invalid_voice_id on persona update:** Pre-existing persona validation issue. Returns 400 on certain updates but does not affect core functionality.
5. **`railway redeploy` does not rebuild:** As documented in DEPLOYMENT.md, `railway redeploy` may serve stale code. Always use `railway up --detach` for actual code changes.

## Evidence

### Git evidence

```
# adminAuth require introduced in commit d7344a9
$ git show d7344a9:src/server.js | grep adminAuth
const { createAdminAuth } = require('./auth/adminAuth');

# adminAuth file was NEVER committed
$ git log --all --oneline -- src/auth/
(no output)

# adminAuth file exists only in dirty working tree
$ git -C D:\AI\wine-ai-realtime status --short -- src/auth/
?? src/auth/

# adminAuth.js is untracked, created 2026-07-25 00:19
$ ls -la D:\AI\wine-ai-realtime\src\auth\adminAuth.js
4959 bytes, 25.07.2026 0:19
```

### Railway crash logs (deployment 4476986a)

```
Error: Cannot find module './auth/adminAuth'
Require stack:
- /app/src/server.js
    at Module._resolveFilename (node:internal/modules/cjs/loader:1207:15)
    at Object.<anonymous> (/app/src/server.js:37:29)
    code: 'MODULE_NOT_FOUND'
```

### Recovery evidence

```
# Repair commit pushed to origin/main
$ git rev-parse origin/main
1efba7e0178eb088c0bba452f3425a37fc5f9615

# Successful deployment
$ railway deployment list
4b2c2c85-6dec-459b-b455-f7c1cbaec2ab | SUCCESS | 2026-07-27 00:33:44 +03:00

# Production endpoints
GET /health              → 200 { ok: true, provider: gemini }
GET /api/persona         → 200 { ok: true, activeProfileId: classic }
GET /api/persona/profiles → 200 { profiles: [classic, warm_guide] }
```
