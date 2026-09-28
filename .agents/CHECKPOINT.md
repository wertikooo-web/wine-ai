# Mission checkpoint

- goal: WINE AI Cost & Usage Control end-to-end (usage persistence, pricing table, MDL/EUR, budget observability, Dashboard tab Расходы / Cost Control), deployed and verified in production.
- completed: Implemented on branch `claude/wine-ai-cost-usage-xc5m2x` (src/cost/*, additive provider/realtime hooks, /api/cost/*, public/cost-control.js, docs/COST_CONTROL.md). tests/costControl.test.js 170 assertions pass; tests/costStore.postgres.integration.test.js passes on local PostgreSQL 16. npm test: same 16 fail / 2 skip set as main baseline (pre-existing), +1 OK. Tests after pttFrameGuards (runner exits there on main too) run individually: identical to main. Local E2E (server + Postgres + WS session) produced exactly one row per session.
- decisions: Budget is observability only. Costs re-priced on read from raw usage + versioned ai_pricing. Cost schema separate from KOS migrations. Unknown models are UNPRICED, not guessed. Grok priced per measured minute (ESTIMATED). Cost writes gated by ADMIN_TOKEN when set.
- blockers: Sandbox network policy blocks the Railway production host; production verification runs through the Railway Production Smoke workflow (new Cost Control step, post-merge only).
- production_state: unchanged/not inspected (pre-merge).
- next_action: commit, push, open PR, merge after checks, verify production via Railway Production Smoke on main.
