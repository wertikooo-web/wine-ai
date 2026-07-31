# Knowledge search contract

Use current search and tool implementations plus tests as the exact payload contract.

Search accepts a user query and retrieval options and returns structured evidence suitable for a realtime tool result. Empty results are valid. Semantic failure must degrade safely when keyword fallback is supported.

Changing argument or result shapes requires updating every caller, provider tool declaration, prompt/tool adapter, UI consumer, and test in the same change.
