# ANTIGRAVITY_MIGRATION_PROPOSAL.md — Antigravity migration proposal

## Status

**PROPOSAL ONLY** — not verified from repository files or configuration.

Antigravity context-loading format is not documented in this repository. The sections below are proposals based on general knowledge of agent context systems, not verified from actual Antigravity configuration.

## What is Antigravity

Antigravity is an AI agent platform (not verified from repository files). The exact context-loading format is unknown and must be verified before implementation.

## Proposed migration path

### Phase 1: Verify Antigravity format

Before any migration work, verify:
1. How Antigravity loads agent context files
2. What file format Antigravity expects (Markdown, JSON, etc.)
3. How Antigravity handles progressive loading
4. What Antigravity's equivalent of `CLAUDE.md` / `AGENTS.md` is

### Phase 2: Map existing context to Antigravity format

Once format is verified, map:
- `PROJECT.md` → Antigravity project context
- `ARCHITECTURE.md` → Antigravity architecture context
- `INVARIANTS.md` → Antigravity rules/constraints
- `CONTEXT_MAP.md` → Antigravity progressive loading
- `DEFINITION_OF_DONE.md` → Antigravity completion criteria
- Domain files → Antigravity domain contexts
- Contract files → Antigravity interface contracts

### Phase 3: Create Antigravity configuration

Create Antigravity-specific configuration files:
- `.antigravity/` directory (or equivalent)
- Context loading rules
- Skill triggers (if applicable)
- Agent entry point

### Phase 4: Test and validate

- Verify Antigravity can load all context files
- Verify progressive loading works
- Verify domain-specific loading works
- Verify no regressions in existing workflows

## What NOT to migrate

- **Codex instructions** belong in `AGENTS.next.md`, not here
- **Production code** must not change
- **Active `CLAUDE.md` / `AGENTS.md`** must not be modified
- **Database schema** must not change
- **Dependencies** must not change
- **Env files** must not change
- **Deployment configuration** must not change

## Open questions

1. What is the exact Antigravity context-loading format?
2. Does Antigravity support progressive loading?
3. Does Antigravity support skill triggers?
4. What is Antigravity's equivalent of `CLAUDE.md` / `AGENTS.md`?
5. How does Antigravity handle domain-specific contexts?
6. Does Antigravity support contract files?

## Next steps

1. **Verify Antigravity format** from official documentation or repository files
2. **Update this proposal** with verified information
3. **Create migration plan** once format is verified
4. **Implement migration** only after plan is approved
