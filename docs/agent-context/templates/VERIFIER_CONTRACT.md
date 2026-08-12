# Independent verifier contract

Provide only the following clean-context package:

```yaml
goal: <approved end state>
acceptance_criteria:
  - <criterion>
diff_or_result: <patch, commit, artifact, or runtime result>
relevant_tests:
  - command: <exact command>
    result: <exit code and concise evidence>
```

Do not include the author's working conversation, implementation narrative, or reasoning.

Verifier task:

1. Try to disprove the result against the goal and acceptance criteria.
2. Find blockers, regressions, contradictory instructions, unsafe authority expansion, and missing evidence.
3. Do not modify the result and do not confirm the author by default.
4. Return only:

```yaml
verdict: pass | changes_required | blocked
blockers:
  - evidence: <file:line, command output, or observable result>
    impact: <why acceptance or safety fails>
non_blocking:
  - <optional improvement>
missing_evidence:
  - <required proof not supplied>
```
