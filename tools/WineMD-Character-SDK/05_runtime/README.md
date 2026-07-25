# Runtime
Use the official Rive web runtime and adapt its state-machine inputs to `RiveInputAdapter`. Provider-specific logic belongs in WineMD's Visual Orchestrator.

`src/SommelierController.ts` and `src/types.ts` in this directory are **specification/reference only** — they do not compile or run as part of the current application (no TypeScript build step exists in this repo). The runtime source of truth is `public/visual/*.mjs` (`avatarCommandSchema.mjs`, `avatarSemanticAdapter.mjs`, `riveAvatarAdapter.mjs`). Keep these `.ts` files in sync manually for reference/comparison purposes only.
