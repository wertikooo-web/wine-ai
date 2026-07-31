# Known Test Issues

This document records confirmed pre-existing test and environment problems.

Agents must verify that a failure matches this record and that the current diff does not touch the affected area before treating it as pre-existing.

## Current known issues

### PostgreSQL integration tests

Symptom:

`getaddrinfo ENOTFOUND base`

Cause:

Some test runs set `DATABASE_URL=memory`, while PostgreSQL-dependent code treats the value as an enabled database URL and attempts to connect to host `base`.

Status:

Pre-existing environment/test harness issue.

Do not investigate during unrelated tasks.

### searchWineKnowledgeFallback.test.js

Symptom:

The project runner may report the file as passed with zero assertions.

Cause:

The file uses `node:test` format while the project runner expects a `run()` export.

Status:

This is not meaningful green coverage.

Do not cite it as proof until fixed.

### pttFrameGuards.test.js

Symptom:

The full suite may stall at this test in the current local environment.

Status:

Pre-existing realtime test-runner behavior.

Run independently only when the current task concerns realtime frame guards.

### entityResolver tests

Symptom:

Known fuzzy-matching assertion drift.

Status:

Investigate only when entity resolution or aliases are changed.

### kosDocumentParsingService tests

Symptom:

Known MIME-type assertion drift.

Status:

Investigate only when parsing or MIME handling is changed.

## Updating this file

For every issue record:

- exact test name;
- exact symptom;
- verified cause;
- commit or date confirmed;
- conditions under which it may be ignored;
- owner or follow-up issue, when available.

Do not add a failure here merely because it is inconvenient.
