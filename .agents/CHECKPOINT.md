# Mission checkpoint

- goal: Establish one repository-wide agent workflow standard and land it as a documentation-only PR.
- completed: Added the canonical workflow, checkpoint and verifier templates, examples, and consolidated AGENTS.md, CLAUDE.md, .agents rules, legacy workflow/autonomy indexes, verification, and domain safety references. Self-review passed path audit for 16 files, 15 required-content markers, documentation-only scope, contradiction search, and git diff --cached --check. Runtime files are unchanged.
- decisions: Use docs/agent-context/AGENT_WORKFLOW.md as the sole workflow source of truth; keep this file as the sole current-mission checkpoint; keep WINE-specific test details in VERIFICATION.md; retain old entrypoints only as compatibility links.
- blockers: none; independent verifier pass 1 found duplicate escalation authority in domains/security.md, the focused fix was applied, and verifier pass 2 returned pass with no blockers or missing evidence.
- production_state: unchanged; documentation-only branch; no deploy requested or allowed.
- next_action: Commit and push the documentation-only branch, open the PR, wait for required checks, then merge only if that does not trigger a prohibited production deploy.
