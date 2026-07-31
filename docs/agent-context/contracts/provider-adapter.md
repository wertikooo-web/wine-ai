# Provider adapter contract

Use the current provider registry, adapter implementations, and tests as the exact source of truth.

An adapter is responsible for provider connection, audio/input signaling, response events, tool-call transport, interruption, error reporting, and cleanup. It must preserve session, turn, generation, response, and provider correlation data.

An adapter does not own application generation completion. Every emitted event must be safe to reject as stale, and close/interrupt operations must be idempotent.
