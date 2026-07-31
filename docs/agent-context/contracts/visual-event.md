# Visual event contract

Use `src/visual/visualProtocol.js`, the orchestrator, renderers, and tests as the exact event contract.

Every event is generation-scoped and must be ignored when stale. Reset, cancel, and completion behavior must be deterministic across interruption, disconnect, and replacement generations.

Do not allow provider adapters to bypass the orchestrator. Do not add raw executable HTML or unsafe content fields to visual payloads. DOM/CSS and Rive renderers must consume the same protocol.
