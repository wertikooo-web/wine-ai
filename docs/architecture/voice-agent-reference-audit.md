# Voice Agent Reference Audit: WineAI vs. Customer Support Voice Agent

This document presents a technical audit comparing the production-grade, streaming realtime architecture of **WineAI** with the reference project **Customer Support Voice Agent** (from Shubham Saboo's `awesome-llm-apps`).

---

## 1. Executive Summary

- **WineAI** is a high-performance, native real-time assistant utilizing persistent bi-directional WebSockets, low-latency audio streaming (PCM16), active VAD/interruption (barge-in) handling, and multi-provider rotation.
- **Reference Project** is a simple, single-turn, text-based Streamlit application written in Python. It simulates "voice" by passing text to a TTS agent, requesting a batch MP3 file from OpenAI's `gpt-4o-mini-tts` model, and playing it in the browser. It contains no WebSocket logic, no streaming audio input, no tools, no concurrency orchestration, and no real-time barge-in capability.
- **Audit Decision**: **`KEEP_WINE_AI`** is the dominant decision across all categories. The reference project offers no architectural patterns that are suitable for WineAI's real-time core.
- **Identified Defect in WineAI**: During this audit, we identified a critical integration bug in the newly merged **Classic voice engine** (`src/realtime/classicVoiceProvider.js`): it passes un-wrapped arguments directly to tool handlers, causing all tool calls in Classic mode to execute with empty parameters `{}`. We propose fixing this immediately as our narrow scope.

---

## 2. Detailed Comparison Matrix

| Area | WineAI сейчас | Reference сейчас | Разрыв | Польза | Риск | Решение |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Voice Pipeline** | Native real-time streaming (microphone PCM16 input -> WebSocket -> Gemini Live/Grok -> streaming WAV output). See [realtimeServer.js](file:///d:/AI/wine-ai-realtime/src/realtime/realtimeServer.js). | Single-turn text RAG + final TTS batch synthesis to MP3. See [customer_support_voice_agent.py:L245-312](file:///C:/Users/user/.gemini/antigravity/brain/78adfc27-334b-48b6-a9a6-d7e37ef0bf27/scratch/customer_support_voice_agent.py#L245-L312). | Reference lacks real-time audio input processing and low-latency streaming. | None. Adopting the reference approach would degrade WineAI to a slow, non-streaming cascade. | High: complete loss of real-time experience. | **`KEEP_WINE_AI`** |
| **Provider Abstraction** | Unified registry and provider interfaces. See [providerRegistry.js](file:///d:/AI/wine-ai-realtime/src/realtime/providerRegistry.js). | Hardcoded OpenAI client wrapper. See [customer_support_voice_agent.py:L286-293](file:///C:/Users/user/.gemini/antigravity/brain/78adfc27-334b-48b6-a9a6-d7e37ef0bf27/scratch/customer_support_voice_agent.py#L286-L293). | Reference has no provider abstraction or registry. | None. WineAI supports Gemini Live, Grok Voice, and Classic. | None. | **`KEEP_WINE_AI`** |
| **Session Lifecycle** | Full WS lifecycle (connect, auth, sample rate config, audio stream, interrupt, close). See [realtimeServer.js](file:///d:/AI/wine-ai-realtime/src/realtime/realtimeServer.js#L530-580). | In-memory Streamlit session state reset on refresh. See [customer_support_voice_agent.py:L21-40](file:///C:/Users/user/.gemini/antigravity/brain/78adfc27-334b-48b6-a9a6-d7e37ef0bf27/scratch/customer_support_voice_agent.py#L21-L40). | Reference lacks real-time connection state management. | None. WineAI's session handling is production-ready. | None. | **`KEEP_WINE_AI`** |
| **Conversation State** | In-memory generation queue + session memory tool. See [sessionMemory.js](file:///d:/AI/wine-ai-realtime/src/memory/sessionMemory.js) and [updateSessionMemory.js](file:///d:/AI/wine-ai-realtime/src/tools/updateSessionMemory.js). | Standard list of dicts in Streamlit state. See [customer_support_voice_agent.py:L162](file:///C:/Users/user/.gemini/antigravity/brain/78adfc27-334b-48b6-a9a6-d7e37ef0bf27/scratch/customer_support_voice_agent.py#L162). | Reference lacks session isolation and memory synchronization. | None. | None. | **`KEEP_WINE_AI`** |
| **Tool Registry** | Declared in [src/tools/index.js](file:///d:/AI/wine-ai-realtime/src/tools/index.js) and mapped to providers. | No tools supported or defined in the reference. | Reference does not support tool calling. | None. WineAI's registry is lightweight and decoupled. | None. | **`KEEP_WINE_AI`** |
| **Tool Schemas** | Gemini-compatible function schemas. See [searchWinery.js](file:///d:/AI/wine-ai-realtime/src/tools/searchWinery.js#L6-L23). | N/A | Reference does not support tool calling. | None. | None. | **`KEEP_WINE_AI`** |
| **Tool Executor** | Managed in [toolHelpers.js](file:///d:/AI/wine-ai-realtime/src/tools/toolHelpers.js) via `bindTool` closure wrapper (handles validation, duration, logs). | N/A | Reference has no tool execution engine. | None. | None. | **`KEEP_WINE_AI`** |
| **Intent Routing** | Grounded prompts + Answerability Gate for web fallback. See [layeredRouter.js](file:///d:/AI/wine-ai-realtime/src/knowledge/layeredRouter.js). | Hardcoded RAG lookup to Qdrant. See [customer_support_voice_agent.py:L255-278](file:///C:/Users/user/.gemini/antigravity/brain/78adfc27-334b-48b6-a9a6-d7e37ef0bf27/scratch/customer_support_voice_agent.py#L255-L278). | Reference uses direct similarity query with no intent gating or fallback checks. | None. WineAI's Answerability Gate is significantly more advanced. | None. | **`KEEP_WINE_AI`** |
| **Retries** | WebSocket level reconnection and provider failover. See [realtimeServer.js](file:///d:/AI/wine-ai-realtime/src/realtime/realtimeServer.js). | None. | Reference has no retry logic. | None. | None. | **`KEEP_WINE_AI`** |
| **Timeouts** | Connection timeouts, playback, and network abort handling. See [geminiLiveProvider.js](file:///d:/AI/wine-ai-realtime/src/realtime/geminiLiveProvider.js). | None. | Reference lacks async timeout guards. | None. | None. | **`KEEP_WINE_AI`** |
| **Cancellation** | WS-native interrupt frame handling + prompt cancellation. See [realtimeServer.js](file:///d:/AI/wine-ai-realtime/src/realtime/realtimeServer.js) and [geminiLiveProvider.js](file:///d:/AI/wine-ai-realtime/src/realtime/geminiLiveProvider.js). | None. | Reference has no cancellation logic for ongoing requests. | None. | None. | **`KEEP_WINE_AI`** |
| **Error Mapping** | Maps unhandled tool errors to `tool_execution_failed` to prevent internal stack leak. See [toolHelpers.js](file:///d:/AI/wine-ai-realtime/src/tools/toolHelpers.js#L76-L103). | Generic try-except block returning string error. See [customer_support_voice_agent.py:L314-319](file:///C:/Users/user/.gemini/antigravity/brain/78adfc27-334b-48b6-a9a6-d7e37ef0bf27/scratch/customer_support_voice_agent.py#L314-L319). | Reference leaks raw Python exception details. | None. WineAI's mapping is safer and more secure. | None. | **`KEEP_WINE_AI`** |
| **Structured Logging** | Real-time console logs of connection transitions, VAD metrics, and tool execution. See [realtimeServer.js](file:///d:/AI/wine-ai-realtime/src/realtime/realtimeServer.js). | Standard streamlit stream outputs. | Reference lacks structured production logging. | None. | None. | **`KEEP_WINE_AI`** |
| **Tracing** | Raw WS packet logging (excluding secrets/transcripts). See `logRawProviderMessage` in [geminiLiveProvider.js](file:///d:/AI/wine-ai-realtime/src/realtime/geminiLiveProvider.js#L1077-1080). | None. | Reference does not support tracing. | None. | None. | **`KEEP_WINE_AI`** |
| **Metrics** | Local VAD energy logs and generation latency tracking. See [dashboardBargeIn.test.js](file:///d:/AI/wine-ai-realtime/tests/dashboardBargeIn.test.js). | None. | Reference has no metrics collection. | None. | None. | **`KEEP_WINE_AI`** |
| **Test Coverage** | 100+ tests including WS connection simulation and integration tests. See `tests/`. | None. | Reference has no tests. | None. | None. | **`KEEP_WINE_AI`** |
| **Security** | SSRF protection for knowledge tools. Address credentials verification, port constraints, and socket pinning. See [ssrfProtection.js](file:///d:/AI/wine-ai-realtime/src/knowledge/safeFetch.js). | None. | Reference allows arbitrary URLs without validation. | None. | None. | **`KEEP_WINE_AI`** |
| **Prompt Structure** | Split into Persona and Live context files. Grounded instructions for Moldovan wine facts. See [persona/](file:///d:/AI/wine-ai-realtime/src/persona/). | Simple hardcoded multi-line instruction strings. See [customer_support_voice_agent.py:L221-240](file:///C:/Users/user/.gemini/antigravity/brain/78adfc27-334b-48b6-a9a6-d7e37ef0bf27/scratch/customer_support_voice_agent.py#L221-L240). | Reference instructions are basic and monolithic. | None. | None. | **`KEEP_WINE_AI`** |
| **Streaming** | Bidirectional audio streaming over WebSockets. | None. Streamlit plays a fully formed static MP3 file. | Reference lacks real-time streaming capability. | None. | None. | **`KEEP_WINE_AI`** |
| **Barge-In** | Local VAD barge-in hysteresis and prompt interrupt handling. See [dashboardBargeIn.test.js](file:///d:/AI/wine-ai-realtime/tests/dashboardBargeIn.test.js). | None. | Reference does not support user interruption. | None. | None. | **`KEEP_WINE_AI`** |

---

## 3. Findings & Recommendations

### Summary of Strengths in WineAI
1. **Low Latency Core**: The bidirectional WebSocket audio streaming loop is mature and handles errors/retries smoothly.
2. **SSRF Guard**: The production HTTP client has robust built-in protection against SSRF attacks.
3. **Answerability Gate**: Restricting external search fallbacks on non-answerable queries is far more advanced than the basic RAG vector match.

### Bug identified in `ClassicVoiceProvider` tool execution
The newly integrated classic engine (`src/realtime/classicVoiceProvider.js`) executes tool calls using `await handler(call.args || {})`. However, the tool handler wrapped via `bindTool` in `src/tools/toolHelpers.js` expects the arguments to be formatted inside a parent object: `{ args: call.args, generationId, turnId }`.
Due to this format mismatch, the destructured `args` inside the tool handler defaults to `{}`, rendering all tools non-functional under the classic engine because they receive empty inputs.

### Recommendation
Fix the argument passing in [classicVoiceProvider.js](file:///d:/AI/wine-ai-realtime/src/realtime/classicVoiceProvider.js) by wrapping the arguments structure correctly, and introduce automated unit tests to verify tool execution within the Classic voice engine.
