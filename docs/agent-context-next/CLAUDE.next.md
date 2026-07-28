# CLAUDE.next.md — Agent entry point (v2)

## Skill triggers

- `/graphify` → invoke `~/.claude/skills/graphify/SKILL.md`
- `/design` → invoke `~/.claude/skills/design/SKILL.md`
- `/impeccable` → invoke `~/.claude/skills/impeccable/SKILL.md`

## Project context

This repository is an independent realtime voice digital expert on Moldovan wine. It reuses a realtime transport/session core originally proven in an unrelated children's-voice-toy project (`lunara-realtime`). That origin is implementation history only — this repository must never import from, run inside, or depend on the runtime state of that other project.

**Read these files in order for project context:**
1. `docs/agent-context-next/PROJECT.md` — what the project is, key paths
2. `docs/agent-context-next/ARCHITECTURE.md` — components, state machines, contracts
3. `docs/agent-context-next/INVARIANTS.md` — safety, production, and architectural invariants
4. `docs/agent-context-next/CONTEXT_MAP.md` — progressive loading guide for task types
5. `docs/agent-context-next/DEFINITION_OF_DONE.md` — completion criteria and verification

**For domain-specific tasks, load the relevant domain file from `docs/agent-context-next/domains/`:**
- `realtime-voice.md` — WebSocket session, turn lifecycle, PTT, barge-in
- `provider-adapters.md` — Gemini, Grok, Mock adapter contracts
- `knowledge-retrieval.md` — search, embeddings, KOS pipeline
- `visual-system.md` — visual orchestrator, events, B-roll
- `database.md` — schema, migrations, KOS tables
- `security.md` — secrets, SSRF, deployment gates

**For interface contracts, load from `docs/agent-context-next/contracts/`:**
- `provider-adapter.md` — provider adapter interface
- `visual-event.md` — visual event protocol
- `knowledge-search.md` — knowledge search contract

## Hard rules

- **Independence:** No `require`/`import` pointing outside this repository's own `src/`. No npm workspace, git submodule, or symlink back to any sibling project. Do not add child-toy domain concepts.
- **Safety:** Start in read-only mode for analysis/audit/planning. Change only files explicitly required by the task. Stop before production actions unless explicitly approved. Never print secrets.
- **Repository:** Before editing: confirm root and branch, run `git status --short`, preserve unrelated work.
- **Deployment gates:** `npm run check:missing-imports`, `node --test tests/startupNoAdminAuth.test.js`, `npm run test:smoke`, CI green. Do not skip.
- **Unfinished features:** Never merge/import a file that does not yet exist. Complete the feature in the same branch, verify with `check:missing-imports`, then merge/deploy.
- **Audio:** Push-to-talk only. Do not switch to VAD. No `node -r` injection, monkey patches, or hidden bootstrap.
- **Turn lifecycle:** One authoritative lifecycle (generation object). Stale generationId never affects newer turn. No arbitrary delays.
- **Knowledge:** `search(query, options)` signature must not change without updating all callers. Empty knowledge base is normal.
- **Visual:** No LLM provider touches visual events directly. `html` field forbidden. Rive is alternative renderer, not replacement.

## Working style

- Prefer the smallest clear change that solves the demonstrated problem.
- Prefer readable control flow over hidden runtime behavior.
- Do not change providers, transport, persona, knowledge, and audio architecture in one change unless the task requires the combination.
- Record assumptions when behavior cannot be proven from code or tests.

## Test strategy

- **During development:** run only tests for files/modules you changed.
- **Before closing a stage:** run full test suite once:
  ```text
  npm test
  npm run test:smoke
  ```
- No Blind Mocking: avoid mocking internal utility files unless they make remote network requests.
- Mandatory Live Reload Check: after editing files affecting API routes or frontend scripts, restart server and verify with real HTTP check.
- No Unnecessary Test Execution: do NOT run entire test suite during development unless explicitly requested.

## Multilingual

Supported languages: Russian, Romanian, English (+ French, Italian, Spanish, German, Chinese, Japanese for detection). Auto-detect; reply in the language of the last clearly understood utterance. Do not flap on a single foreign word or name. Winery/grape/region proper nouns must not be treated as language-switch signals.
