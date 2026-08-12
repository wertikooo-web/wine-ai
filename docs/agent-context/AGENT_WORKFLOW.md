# Agent Workflow Standard

This document is the single source of truth for how coding and research agents execute missions in this repository. Product and domain invariants remain in `INVARIANTS.md`; surface-specific checks remain in `VERIFICATION.md`. Other agent instructions must link here instead of restating this workflow.

## 1. Mission start

For every new mission:

1. Read `AGENTS.md`, this document, and `.agents/CHECKPOINT.md`.
2. Read `PROJECT.md`, select one route from `CONTEXT_MAP.md`, and load only the relevant domain, contract, code, and tests.
3. Reconcile the checkpoint with the current branch, working tree, PR, CI, and production state. Current evidence wins over stale checkpoint text.
4. Write or refresh the checkpoint before implementation. Keep it short and factual.
5. Define the goal, acceptance criteria, protected scope, validation plan, and stop condition.

One mission has one canonical checkpoint: `.agents/CHECKPOINT.md`. Do not create competing status, handoff, or scratch checkpoint files.

## 2. Checkpoint memory

The checkpoint must contain exactly these fields:

- `goal`: the approved end state;
- `completed`: verified work already finished;
- `decisions`: decisions that constrain later work;
- `blockers`: unresolved blockers with evidence, or `none`;
- `production_state`: observed production/deployment state, or `unchanged/not inspected`;
- `next_action`: the next concrete action.

Update it:

- after every merge or deploy;
- before context compaction when the environment exposes that boundary;
- before handing the mission to another agent or session;
- when a decision, blocker, or production fact materially changes;
- at mission completion.

Do not use it as a diary. Record facts, identifiers, commands/results when operationally useful, and no hidden reasoning.

Template: `docs/agent-context/templates/CHECKPOINT_TEMPLATE.md`.

## 3. Execution loop and stop rules

Use the bounded loop:

```text
implement → targeted test → identify the weakest failure → fix → retest
```

Rules:

- Start with the narrowest deterministic check that can disprove the change.
- Make at most three automatic fix/retest passes for the same blocker.
- A new pass requires a new hypothesis or a material change that could affect the result.
- After the third failed pass, stop and report the blocker, the three hypotheses/actions, and concrete evidence.
- Do not repeat a full suite, benchmark, audit, deployment, or log query without a new hypothesis.
- Do not mark completion while a required check is failing or unobserved.

Run the full suite only when the change affects a broad runtime contract or when a required repository/CI gate demands it. For a local bug, run targeted tests first. Repeat a benchmark only after a change that could affect its metric. Prefer deterministic code, SQL, or repository evidence over another LLM agent.

## 4. Independent verifier

A separate verifier is mandatory for a substantial PR or any runtime, schema, migration, security, deployment, or production change. Documentation-only changes require a verifier when they materially change agent authority, safety rules, architecture, or public contracts.

The verifier must be independent of the author. Give it only:

- goal;
- acceptance criteria;
- diff or produced result;
- relevant test evidence.

Do not provide the author's working conversation, implementation narrative, or reasoning. The verifier's job is to find blockers and regressions, not to endorse the author.

The verifier returns a structured verdict:

```yaml
verdict: pass | changes_required | blocked
blockers:
  - evidence: file:line, command output, or observable result
    impact: why acceptance or safety fails
non_blocking:
  - optional improvement
missing_evidence:
  - required proof not supplied
```

The author resolves blockers through the bounded loop, reruns relevant checks, and requests a fresh verifier verdict. Template: `docs/agent-context/templates/VERIFIER_CONTRACT.md`.

## 5. Parallel fan-out and reduce

Fan out only truly independent work. Apply the fake-edge test before dispatch:

> If task B does not consume task A's output, no dependency edge exists and they may run in parallel.

If either task needs the other's output, run them sequentially. Parallel workers must receive bounded scopes and return structured outputs. Their results converge through a separate reducer or verifier that checks contradictions, missing coverage, and acceptance criteria. The author remains responsible for the combined result.

Do not use fan-out when deterministic code or one focused read can answer the question more cheaply.

## 6. Mission autonomy and escalation

Once the end mission and scope are explicitly approved, the agent proceeds without repeated permission for safe in-scope steps, including branch creation, commits, PR creation, merge after green required gates, and deployment when deployment is part of the approved mission and environment.

Stop and request direction only for:

- risk of irreversible production-data loss;
- a destructive operation without a tested rollback or recoverable backup;
- a new paid service or external dependency;
- a change to the approved architecture or mission scope;
- a genuine blocker that cannot be resolved safely with repository and environment evidence.

Approval for one mission does not authorize unrelated production changes. Production evidence and rollback requirements in domain instructions still apply.

## 7. Verification and cost discipline

Choose checks by changed surface using `VERIFICATION.md` and current `package.json`/CI as evidence. Record what ran, what passed, what was skipped, and why.

- Documentation-only: link/path audit, contradiction search, Markdown/content checks, `git diff --check`, and required documentation CI.
- Narrow code change: targeted unit/integration check, then only affected smoke/runtime paths.
- Broad runtime contract: targeted checks first, then the required broader gates.
- Schema/production: dry run or preview, rollback evidence, affected-row expectations, and independent verification before write.

Never rerun a check already proven for the unchanged artifact. CI may satisfy a local gate when it runs the same revision and command.

## 8. Completion

A mission is complete when acceptance criteria are met, the diff/result is reviewed, required checks and independent verification are green, the checkpoint is final, and no required work remains. Final reporting must state changed files, checks and results, skipped checks, remaining uncertainty, PR/merge/deploy state, and the exact blocker if incomplete.

## Example: coding mission

```text
Goal: fix stale playback after interruption.
Checkpoint: record goal, observed failing test, protected PTT behavior, production unchanged.
Implement: minimal generation-ownership fix.
Pass 1: targeted interruption test fails at stale chunk rejection.
Fix: reject chunks whose generation ID is inactive.
Pass 2: targeted test and affected smoke path pass.
Verify: independent verifier receives goal, acceptance criteria, diff, and test output only.
Finish: update checkpoint, commit, PR, merge after required green gates; deploy only if included in the approved mission.
```

## Example: fan-out and reduce

```yaml
goal: assess a provider-adapter change
fan_out:
  - id: contract_check
    input: adapter diff + provider contract
    output: {violations: [], evidence: []}
  - id: test_check
    input: changed tests + test output
    output: {gaps: [], failures: []}
fake_edge_test: test_check does not consume contract_check output; run in parallel
reduce:
  input: [contract_check, test_check]
  output: verifier verdict against the shared acceptance criteria
```
