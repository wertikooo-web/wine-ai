# DEFINITION_OF_DONE.md

A task is complete only when:

- the requested scope is satisfied;
- unrelated work remains untouched;
- architecture and state ownership rules are preserved;
- native realtime behavior remains distinct from any classic STT/LLM/TTS mode;
- affected PTT and Tap-to-Start paths are verified separately when relevant;
- provider, playback, visual, and knowledge events cannot mutate stale generations;
- relevant tests and runtime checks pass, or limitations are reported honestly;
- the final diff is reviewed for duplicate instructions, obsolete paths, missing files, and accidental scope growth;
- documentation and code agree on public contracts and current behavior;
- no secrets or production data are exposed;
- mission authority, verification, merge, deploy, escalation, and stop rules in `AGENT_WORKFLOW.md` are satisfied.
