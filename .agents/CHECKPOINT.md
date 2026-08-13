# Mission checkpoint

- goal: Establish one repository-wide agent workflow standard and land it as a documentation-only PR.
- completed: Added the canonical workflow, checkpoint and verifier templates, examples, and consolidated agent instructions. Self-review passed all documentation checks. Independent verifier passed after one focused correction. Commit e1c3ef9 is pushed; PR #61 is mergeable and all required GitHub checks are green. PR #61 merged to main on 2026-08-13 as commit 2e253dd. Follow-up fixed opencode.json to point at the canonical `docs/agent-context/AGENT_WORKFLOW.md` instead of a non-existent path.
- decisions: Use docs/agent-context/AGENT_WORKFLOW.md as the sole workflow source of truth; keep this file as the sole current-mission checkpoint; keep WINE-specific test details in VERIFICATION.md; retain old entrypoints only as compatibility links.
- blockers: none.
- production_state: last recorded value was unchanged at Railway commit f382744, deployment f7b71b07-539d-4276-a074-a9a559bbc72f. The docs-only merge 2e253dd (PR #61) is on main; whether it triggered Railway autodeploy was not re-inspected.
- next_action: none — mission complete.
