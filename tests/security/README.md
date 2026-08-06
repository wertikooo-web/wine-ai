# WINE AI Security Suite

This directory contains product-specific regression cases for the WINE AI voice sommelier.

## Current scope

The first foundation covers:

- prompt injection;
- RAG poisoning;
- commercial recommendation integrity;
- unsafe rendered output;
- admin authorization;
- realtime WebSocket abuse;
- cross-session memory isolation;
- public secret exposure.

## Run locally

```bash
npm run test:security
```

The foundation validator checks that every case has a unique ID, severity, category, and explicit expected behavior. Critical categories are required, so the suite cannot silently lose an entire protection area.

## Current limitation

This first stage validates the attack library and its release-gate structure. It does not yet send attacks to a deployed WINE AI instance. Runtime adapters for REST, realtime WebSocket, rendered cards, and synthetic RAG documents will be added in the next stage.

## Release rule

Any runtime case marked `critical` must block release when the real adapter reports a failure.
