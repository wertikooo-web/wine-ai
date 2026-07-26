# Deployment (Railway)

## `railway redeploy` does not always rebuild from the latest git commit

Observed directly (2026-07-26): after `git push`, running

```bash
railway redeploy --yes
```

reported `SUCCESS` — twice in a row, at different times — while the live
site kept serving code from *before* the push. `redeploy` restarts the
**existing built container/image** for the service; it does not
necessarily trigger a fresh build from the current `HEAD`. A `SUCCESS`
status only means "the container started", not "this is today's code".

What actually forced a real rebuild from the current working directory:

```bash
railway up --detach
```

This uploads the local directory and builds fresh, every time. After using
`railway up`, the deployed content matched the local files exactly.

## How to verify a deploy actually shipped, don't just trust the status

`SUCCESS` in `railway deployment list` is not proof. Confirm the deployed
code directly, e.g. by fetching a page/response and grepping for a string
you know only exists in the new commit:

```bash
curl -s https://wine-ai-realtime-production.up.railway.app/dashboard | grep "some_string_only_in_the_new_commit"
```

If it's missing after a `redeploy` reports `SUCCESS`, run `railway up`
instead and re-check.

## Practical rule for this project

- **After `git push`, prefer `railway up`** if you need to be sure the
  live site reflects the commit you just made, especially when testing
  something immediately (within seconds/minutes of the push) — don't rely
  on `redeploy` or wait for an assumed auto-deploy webhook without
  verifying.
- **`railway redeploy`** is fine for "just restart the service" (e.g. after
  an env var change that doesn't need a new build) — not for "ship my
  latest commit".
- Deployment IDs and their actual git provenance are not obviously linked
  in `railway deployment list` output — when in doubt, verify via content,
  not via status.
