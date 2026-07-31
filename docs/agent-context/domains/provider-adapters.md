# Provider adapters

Adapters isolate Gemini Live, Grok Voice, OpenAI Realtime, and mock-provider behavior from session orchestration.

Keep provider-specific connection, model/voice configuration, activity signaling, audio events, tool calls, interruption, errors, timeout, and cleanup behind the adapter contract and registry.

Adapters emit correlated events; they do not independently own or finalize application generation state. Verify stale-event rejection, interruption, reconnect/cleanup, and contract compatibility for every changed adapter.
