# Mission checkpoint

- goal: Establish one repository-wide agent workflow standard and land it as a documentation-only PR.
- completed: Added the canonical workflow, checkpoint and verifier templates, examples, and consolidated agent instructions. Self-review passed all documentation checks. Independent verifier passed after one focused correction. Commit e1c3ef9 is pushed; PR #61 is mergeable and all required GitHub checks are green.
- decisions: Use docs/agent-context/AGENT_WORKFLOW.md as the sole workflow source of truth; keep this file as the sole current-mission checkpoint; keep WINE-specific test details in VERIFICATION.md; retain old entrypoints only as compatibility links.
- blockers: Merge conflicts with the approved no-deploy constraint: Railway production follows main with empty watchPatterns, and prior docs-only main commit f382744 triggered deployment f7b71b07-539d-4276-a074-a9a559bbc72f. PR #61 must remain open unless no-deploy is relaxed or a Railway configuration change is separately approved.
- production_state: unchanged at Railway commit f382744, deployment f7b71b07-539d-4276-a074-a9a559bbc72f; no deployment was triggered by this mission.
- next_action: Obtain owner direction: keep PR #61 ready without merge, allow the automatic docs-only deployment, or separately approve changing Railway autodeploy/watch settings before merge.
