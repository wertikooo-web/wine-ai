# SommelierSM

Canonical naming convention (fixed 2026-07-25 — see `rive_manifest.json`'s
`gesture` value keys, which previously mixed camelCase with the snake_case
used by `requiredAnimations`): **all wire-level names (input value keys,
animation clip names) are snake_case.** `mode`/`gesture`/`emotion` numeric
values below are unaffected (they're already plain numbers); only the
gesture *value key strings* changed from e.g. `presentWine` to
`present_wine`.

`gesture` also gained a generic `point` value (2026-07-25, post-review):
the real orchestrator's `pointing` state carries no food/pairing semantics
of its own — only its current caller (`runPhase('PAIRING')`) does — so it
must not be pre-mapped to `present_food`. `present_food` stays reserved for
a future explicit pairing/food event. See `troubleshooting.md` #7.

`smile` was considered and removed (2026-07-25, post-review): it was added
as a required animation/trigger with nothing in the real orchestrator ever
signalling a smile moment — an input that existed only to silence a
manifest warning. Re-add only once a real event drives it. See
`troubleshooting.md` #2.

Inputs:
- `mode`: 0 Idle, 1 Listening, 2 Thinking, 3 Speaking.
- `gesture`: 0 None, 1 Welcome, 2 Present Wine (`present_wine`), 3 Present Aroma (`present_aroma`), 4 Present Food (`present_food`), 5 Point (`point`), 6 Goodbye.
- `mouth`: 0 Neutral, 1 A, 2 E, 3 O, 4 MBP.
- `blink`: trigger.
- `emotion`: 0 Neutral, 1 Warm, 2 Delighted, 3 Serious.

Priority: Welcome/Goodbye > presentation gestures > Speaking > Listening/Thinking > Idle. `blink` is a momentary trigger layered on top of whatever the priority above resolves to, not part of the priority chain itself.
