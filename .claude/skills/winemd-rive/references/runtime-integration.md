# Runtime Integration

How to wire a built `.riv` into **this specific app** — vanilla JS/DOM served from `public/`, no React, no Next.js, no bundler (see `architecture.md`'s framework constraint; re-verify this hasn't changed by checking `package.json` before starting).

`tools/WineMD-Character-SDK/09_examples/nextjs/README.md` and `06_winemd/INTEGRATION_PLAN.md` step 1 ("Add `SommelierAvatar` component") assume React. **Do not follow that example as-is.** The correct model to copy is `public/visual/VisualStoryController.mjs`'s own style: a plain ES module, instantiated once, subscribing to the same event stream, no JSX, no component lifecycle.

## Prerequisites before writing any integration code

1. A real `.riv` file exists at a known path (confirm by actually checking the file exists and is non-trivial in size — a 0-byte or placeholder file is not "exists").
2. The official Rive web runtime is installed (`@rive-app/canvas` or `@rive-app/webgl` from npm — check current Rive docs for the recommended package name/version at integration time, since this wasn't verified as installed anywhere in this repo as of 2026-07-25).
3. `SommelierController.ts` has been transpiled or rewritten as plain `.mjs`/`.js` (this repo has no TypeScript build step — `"typecheck"` in `package.json` is literally a no-op echo — so the `.ts` file as-is cannot run here without either a build step this repo doesn't have, or a hand-ported plain-JS equivalent).

## Suggested integration shape (sketch, not a finished file)

```js
// public/visual/RiveAvatarController.mjs — sketch only, verify against the
// actual Rive web-runtime API before treating this as correct.
import { Rive } from '<rive-web-runtime-package>';

export function createRiveAvatarController({ canvasEl, rivPath, stateMachineName = 'SommelierSM' }) {
  let riveInstance = null;
  let activeGenerationId = null;

  const rive = new Rive({
    src: rivPath,
    canvas: canvasEl,
    autoplay: true,
    stateMachines: stateMachineName,
    onLoad: () => { riveInstance = rive; },
  });

  const inputAdapter = {
    setNumber(name, value) {
      const input = rive.stateMachineInputs(stateMachineName).find((i) => i.name === name);
      if (input) input.value = value;
    },
    fire(name) {
      const input = rive.stateMachineInputs(stateMachineName).find((i) => i.name === name);
      if (input) input.fire();
    },
  };

  // apply(event) / endGeneration(id) — see SommelierController contract
  // in references/state-machine-contract.md. Port that class to plain JS
  // here rather than importing the .ts file directly (no TS build step exists).

  return { inputAdapter /* , apply, endGeneration */ };
}
```

## Wiring into the existing event stream

Find wherever the client subscribes to the WebSocket's `visual.*` events today (client-side counterpart of `realtimeServer.js`'s `emit` — check `public/` for the WebSocket message handler that currently routes events to `VisualStoryController`). Add the Rive adapter as an additional (or swappable) subscriber, translating `visual.avatar.state` via the mapping in `state-machine-contract.md` before calling the ported `SommelierController.apply()`.

## Responsive / multi-layout requirement

Per `06_winemd/INTEGRATION_PLAN.md` step 5 and `SKILL.md`'s architecture rule: **one `.riv` for mobile, desktop, tabletop, and kiosk**, using Rive's responsive artboard/layout features (fit modes, alignment) — do not create per-layout `.riv` exports unless a specific, measured technical limitation proves it's necessary. Document any such proof before deviating.

## What this reference cannot tell you

The exact current Rive web-runtime package name, API surface, and import syntax may have changed since this was written — verify against Rive's own current documentation at integration time rather than trusting the sketch above verbatim. Treat it as a shape, not copy-paste-ready code.
