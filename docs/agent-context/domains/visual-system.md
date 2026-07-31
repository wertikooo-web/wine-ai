# Visual system

Visual events are generation-scoped outputs produced through the visual orchestrator. Realtime providers do not directly own visual lifecycle.

A stale visual event must never affect a newer generation. Interruption, cancellation, disconnect, and replacement generation must reset or cancel the previous visual timeline predictably.

The DOM/CSS renderer and a future Rive renderer consume the same public visual protocol. Do not create a second provider-specific visual protocol or bypass the orchestrator.
