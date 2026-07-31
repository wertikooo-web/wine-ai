# WINE AI agent workflow

Always read:

- `AGENTS.md`
- `docs/agent-context/WORKFLOW_EFFICIENCY.md`

Do not preload all files in `docs/agent-context/`.

For every task:

1. Select one route from `docs/agent-context/CONTEXT_MAP.md`.
2. Read only the relevant domain, contract, code, and tests.
3. Provide a plan of no more than 10 lines before editing.
4. Keep the file scope narrow.
5. Run focused tests during implementation.
6. Stop after the requested checkpoint.
7. Keep the final report compact.

Never perform production database writes, destructive SQL, prune, deploy, merge, secret changes, or permission changes without explicit approval for the exact operation.

Before any approved destructive operation, print:

- target environment;
- resolved flags;
- expected affected rows;
- dry-run result;
- rollback or backup status.

Abort destructive cleanup if an earlier creation, migration, embedding, or verification stage fails.
