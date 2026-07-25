---
name: winemd-rive
description: Use for any work on the WineMD 2D sommelier character — creating or modifying the character, preparing PSD/layer art, rigging bones and deformations in Rive, building or editing the Rive State Machine (mode/gesture/mouth/blink/emotion inputs), Idle/Listening/Thinking/Speaking states, lip sync (mouth shapes A/E/O/MBP/neutral), gestures (Present Wine, Present Aroma, Present Food, Welcome, Goodbye), wiring a .riv file into the app via SommelierController, mapping realtime visual events (visual.avatar.state etc.) to Rive inputs, or diagnosing animation/rig/integration problems. Also use when asked to work with tools/WineMD-Character-SDK or anything under .claude/skills/winemd-rive.
---

# WineMD Rive Character Skill

Builds and integrates the WineMD 2D sommelier character on Rive. The spec/starter kit lives in `tools/WineMD-Character-SDK/`; this skill governs how an agent actually uses it against the real `wine-ai-realtime` codebase.

## Ground truth before anything else

1. **`tools/WineMD-Character-SDK/` is a specification and starter kit, not a finished rig.** Its own `README.md` and `rive_manifest.json` (`"status": "production specification / starter implementation"`) say so directly. Treat every claim in it as a hypothesis to verify against real files, not a fact.
2. **No `.riv` file exists anywhere in this repo.** Never claim one does, never fabricate one, never reference a path to one as if it were real.
3. **The real production event system already exists and works**, independent of Rive: `src/visual/visualProtocol.js` (event types, `AVATAR_STATES`), `src/visual/visualOrchestrator.js` (`createVisualOrchestrator`, generationId-scoped), wired into `src/realtime/realtimeServer.js`'s turn lifecycle. `public/visual/VisualStoryController.mjs` is a complete, shipped DOM/CSS renderer of that same event stream — **not Rive, and not to be duplicated or replaced**. A Rive character is a *second, alternative renderer* for the same `visual.*` events, same generationId discipline.
4. **This app has zero React/Next.js anywhere** (`ws` + vanilla `.mjs`/DOM, confirmed via `package.json` and an empty `.jsx`/`.tsx` search). `tools/WineMD-Character-SDK/09_examples/nextjs/` and `06_winemd/INTEGRATION_PLAN.md`'s "`SommelierAvatar` component" language assume React — that assumption is **wrong for this repo** and must be corrected (vanilla JS/DOM, matching `VisualStoryController.mjs`'s own style) before any real integration.
5. **Known inconsistencies inside the SDK itself** — read `references/troubleshooting.md` before trusting the SDK docs blindly. Highlights: `rive_manifest.json` mixes camelCase gesture *values* (`presentWine`) with snake_case *animation names* (`present_wine`) with no mapping table; a `smile` animation is required but no input/trigger can ever invoke it; the real orchestrator's `AVATAR_STATES` (`greeting`, `enthusiastic`, `pointing`, `confirming_order`, `goodbye`) don't map 1:1 onto the SDK's `SommelierMode`/`SommelierGesture`; the real orchestrator never actually emits a `presentAroma`-equivalent gesture today (AROMAS phase has no `avatarState()` call at all).

## Hard rules

- **Verify, don't assume.** Before stating a file, name, or contract is correct, open it. Before saying "the manifest defines X," grep/read the manifest in *this* checkout — it may have changed since any reference doc (including this skill's own references) was written.
- **Never fabricate a PSD or `.riv`.** If asked to "create" one and no real layered source exists, say so and produce the *specification* (templates, layer plan, checklist) instead — never a fake binary or a flattened PNG relabeled as layered.
- **Never claim a file was checked if it wasn't opened this session.** "Should be fine" is not verification.
- **Don't rewrite the realtime/visual-event architecture.** `visualOrchestrator.js` → `visual.*` events → renderer is the existing, working contract. A Rive renderer consumes it; it does not get to redesign it. Flag a real architectural problem instead of silently working around it.
- **Don't introduce a state-management framework** (Redux, Zustand, React, a new pub/sub library) without a demonstrated, written reason tied to a concrete limitation of the current approach.
- **Minimal vertical slice first.** Build Phase 1 (below) completely and verifiably before touching Phase 2. Don't scaffold all three phases' worth of inputs/animations speculatively.
- **Run the validators after every change** (`scripts/`, see below) and report their exact pass/fail output — don't summarize it away.
- **Always end a work session by listing**: files created, files changed, validator results (pass/fail per script), and what remains unverified or blocked on human/Rive-editor work.

## Architecture (do not blur these boundaries)

```
Realtime provider (Gemini / OpenAI / xAI)
        -> WineMD Visual Orchestrator   (src/visual/visualOrchestrator.js — generationId-scoped, already built)
        -> semantic visual event        (visual.avatar.state, visual.wine.show, ... — src/visual/visualProtocol.js)
        -> SommelierController           (tools/WineMD-Character-SDK/05_runtime/src/SommelierController.ts — adapter, unverified/unbuilt)
        -> Rive State Machine            (SommelierSM — no .riv exists yet)
```

**No LLM provider ever touches Rive inputs directly.** The orchestrator is the only thing that knows about turns/generations/interruption; `SommelierController` is a dumb adapter that ignores any event whose `generationId` doesn't match the one it's currently tracking (see `references/state-machine-contract.md` for the exact stale-event rule already written in `SommelierController.ts`).

Independent, separately-managed visual assets (per SDK spec, `01_art_pipeline/ART_REQUIREMENTS_RU.md`): character, counter/stand, bottle, wine glass, and any UI chrome are separate layers/assets — never bake them into one flat image.

One `.riv` artboard should serve mobile, desktop, tabletop, and kiosk via responsive Rive containers/layout, unless a concrete technical constraint (measured, not assumed) proves a layout needs its own file. See `06_winemd/INTEGRATION_PLAN.md` step 5.

## MVP phase order

**Phase 1 (build and verify this first, completely):**
- Idle
- Blink
- Speaking
- Present Wine
- Mouth shapes: Neutral, A, E, O, MBP

**Phase 2 (only after Phase 1 passes every validator and a human review):**
- Listening
- Thinking
- Welcome
- Present Aroma
- Present Food
- Goodbye

**Phase 3 (later, only with a demonstrated need):**
- Emotion states (warm / delighted / serious)
- Gaze targeting
- Audio-driven mouth animation (beyond the simple neutral/A/MBP amplitude switch already specced for MVP)
- Layout-aware gestures

## Reference index

Read the relevant one(s) before acting — don't guess at content this skill already wrote down for you:

| File | Covers |
|---|---|
| `references/architecture.md` | Full layer diagram, where Rive fits, what NOT to duplicate |
| `references/art-pipeline.md` | Master art requirements, what's real vs. still needed in `00_reference/`, `01_art_pipeline/` |
| `references/psd-layer-contract.md` | Exact PSD layer tree, hidden-geometry rules, export rules |
| `references/rive-rig-contract.md` | Bone list, artboard size, rig constraints (rotation/movement limits) |
| `references/state-machine-contract.md` | Every SommelierSM input/value, `SommelierController`/`types.ts` contracts, exact casing |
| `references/animation-library.md` | Every required animation, duration/timing, easing rules |
| `references/visual-events-contract.md` | Real `visual.*` event schema from `src/visual/`, and the (currently incomplete) mapping to `SommelierEvent` |
| `references/runtime-integration.md` | How to wire a built `.riv` into this specific vanilla-JS app (not React/Next.js) |
| `references/testing-checklist.md` | What "MVP verified" means, step by step |
| `references/troubleshooting.md` | Every known inconsistency found in the SDK docs, and how to resolve each one |

## Scripts

Read-only validators, never modify files, exit non-zero on failure:

- `node scripts/validate-rive-manifest.mjs` — checks `tools/WineMD-Character-SDK/03_rive/rive_manifest.json` for required inputs/animations and internal naming consistency.
- `node scripts/validate-visual-events.mjs` — checks a visual-event JSON file (e.g. one built from `templates/visual-event.template.json`) against the real schema in `src/visual/visualProtocol.js`.
- `node scripts/validate-character-assets.mjs` — checks exported PNG/PSD-adjacent assets (size, RGBA, canvas consistency) when present; explicitly reports "cannot verify" for binary `.riv` contents rather than pretending to.

Suggested npm scripts (added to `package.json` only if not already present):
```
npm run avatar:validate
npm run avatar:validate:manifest
npm run avatar:validate:events
npm run avatar:validate:assets
```

## Templates

Starting points, not finished output — fill in with verified project-specific values:
- `templates/character-manifest.template.json`
- `templates/animation-spec.template.md`
- `templates/visual-event.template.json`
- `templates/implementation-report.template.md` — use this exact structure for the end-of-session report described in "Hard rules" above.

## First run

To start Phase 1 work in a fresh session: **"Use the winemd-rive skill to start Phase 1 of the WineMD character (Idle, Blink, Speaking, Present Wine, mouth shapes)."** The skill will re-verify the current state of `tools/WineMD-Character-SDK/` and `src/visual/` before writing anything, since both may have changed since this skill was authored.
