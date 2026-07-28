## When to create a new ADR

Create a new ADR whenever a change:

- introduces a new subsystem;
- changes ownership of state;
- modifies the realtime lifecycle;
- changes provider architecture;
- changes persistence architecture;
- changes networking architecture;
- changes concurrency or synchronization model;
- changes public contracts between major components.

Minor implementation details should not be recorded as ADRs.

# Architectural Decision Records (ADR)

This document records significant architectural decisions made during the development of WINE AI.

Purpose:

- explain why an architectural decision was made;
- document rejected alternatives;
- prevent repeating previously rejected approaches;
- preserve architectural knowledge over time.

Only decisions that affect the long-term architecture of the project should be recorded here.

---

# ADR-001

## Title

Single owner for session lifecycle

## Status

Accepted

## Date

2026-07-27

## Context

The project contains multiple asynchronous components:

- UI
- Audio Capture
- WebSocket Transport
- Realtime Providers
- Playback
- Visual Orchestrator

Without a single owner of the session lifecycle, race conditions and competing state mutations become increasingly likely.

## Decision

The Realtime Session Orchestrator is the single authoritative owner of:

- session lifecycle;
- active turn;
- generation lifecycle.

Other components may observe these states but must not independently own or redefine them.

## Alternatives considered

- Provider-owned lifecycle
- UI-owned lifecycle
- Distributed ownership

## Rejected because

They introduce multiple sources of truth, increase coupling, and make race conditions more difficult to reason about.

## Consequences

Benefits:

- clearer ownership;
- simpler debugging;
- easier testing;
- simpler provider integration.

Trade-offs:

- more responsibility concentrated in the Session Orchestrator;
- requires disciplined architectural boundaries.

---

# ADR-002

## Title

Provider adapters remain thin

## Status

Accepted

## Date

2026-07-27

## Context

WINE AI is expected to support multiple realtime providers.

Provider-specific code should not duplicate common business logic.

## Decision

Provider adapters translate between WINE AI contracts and provider APIs.

Business logic remains outside adapters.

## Alternatives considered

Business logic duplicated in every adapter.

## Rejected because

It creates divergence, inconsistent behavior, and higher maintenance cost.

## Consequences

Adding a new provider should primarily involve implementing a new adapter instead of rewriting business logic.

---

# ADR-003

## Title

Architecture is a first-class project asset

## Status

Accepted

## Date

2026-07-27

## Context

The project is expected to evolve for years, adding providers, devices, interaction modes, and new capabilities.

Without explicit architectural discipline, technical debt accumulates and long-term development slows.

## Decision

Architectural quality has the same priority as functional correctness.

Every feature and bug fix must preserve or improve the architectural clarity of the system.

## Consequences

Implementation speed may occasionally decrease in the short term.

Long-term maintainability, predictability, and development velocity improve.