# Wine AI Realtime

A realtime voice-and-text digital expert on Moldovan wine — wineries, grape varieties, regions, food pairing, and wine tourism. Talk to it in Russian, Romanian, English, French, Italian, Spanish, German, Chinese, or Japanese — it detects your language automatically, or you can pin one via the dashboard's language selector.

## What this is, vs. Lunara Realtime

This project reuses a realtime transport/session core (WebSocket protocol, turn/generation state machine, PCM16 resampling, provider rotation, timeout/retry handling) that was originally proven in a separate, unrelated project: `lunara-realtime`, a children's voice-toy lab. That is implementation history only.

**This is not that project and does not depend on it.** No code here imports from, runs inside, or requires the other repository's runtime state — see `docs/WINE_AI_MIGRATION_PLAN.md` for the full component-by-component migration analysis (what was reused as-is, what was reused as a pattern, what was rewritten from scratch, what was deliberately left out).

Everything domain-specific — persona, prompt content, tools, knowledge base, memory schema, dashboard UI — is new, written for the wine expert use case. No child-safety content, no games, no parental controls, no child data exist in this repository.

## Architecture

See `docs/ARCHITECTURE.md` for the full picture: the turn/generation state machine, the push-to-talk audio pipeline, prompt assembly, the tool (function-calling) contract, and the knowledge-retrieval pipeline.

```text
Dashboard (public/dashboard.html)
  -> PCM16 mic frames or typed text over WebSocket
  -> /realtime session router (src/realtime/realtimeServer.js)
  -> Gemini Live or mock provider (src/realtime/geminiLiveProvider.js)
  -> wine tools (src/tools/*) query the knowledge base (src/knowledge/*)
  -> streaming audio + transcript back to the dashboard
```

## Requirements

- Node.js >= 20
- A Gemini API key for real conversations (`REALTIME_PROVIDER=mock` works with no key at all, for development/testing — it plays a synthetic tone instead of a real reply)

## Install

```bash
npm install
cp .env.example .env
```

Edit `.env` and set `GEMINI_API_KEY` (get one at https://aistudio.google.com/apikey) and `REALTIME_PROVIDER=gemini` for real conversations. Leave `REALTIME_PROVIDER=mock` to run everything else without a key.

## Build the knowledge base

```bash
npm run knowledge:index   # reads knowledge/source/*, writes knowledge/index/index.json
npm run knowledge:check   # validates metadata, reports missing fields / empty index
```

A handful of sample documents (Fetească Neagră, Cabernet Sauvignon comparison, Purcari, Cricova, a roast-lamb pairing guide, the national wine route) ship in `knowledge/source/` so the demo works out of the box.

**Add your own documents** two ways:
1. **Dashboard** — Knowledge base tab, drag a `.md`/`.txt`/`.json`/`.csv` file onto the drop zone (or click it to browse). It's indexed immediately.
2. **Manually** — drop the file into `knowledge/source/` (see the frontmatter format documented in `src/knowledge/loader.js`) and run `npm run knowledge:index`.

There's also an automated crawler (`npm run knowledge:update`, or the Knowledge Monitor panel's "Запустить обновление вручную" button) that pulls from a verified source registry (`src/knowledge/sources/registry.js`) — see `docs/KNOWLEDGE_PIPELINE_ARCHITECTURE.md`.

## Run

```bash
npm run dev
```

Then open:

- `http://localhost:3200/dashboard` — the demo UI (Live avatar / Knowledge base / Persona / Diagnostics tabs)
- `http://localhost:3200/health` — health check

## Using the dashboard

1. Click **Connect**.
2. Either **hold "Hold to talk"** and speak (microphone permission required), or **type a question** in the text box and press Enter/Send.
3. The reply streams back as audio (if a real provider is configured) and always appears as text in the transcript panel.
4. **Stop response** interrupts the assistant mid-reply (barge-in).

Try, in any supported language (ru/ro/en/fr/it/es/de/zh/ja):

- Russian: *«Расскажи, чем Фетяска Нягрэ отличается от Каберне Совиньон.»*
- Romanian: *«Povestește-mi despre soiul Fetească Neagră și despre regiunile în care este cultivat.»*
- English: *"Which Moldovan wine would you recommend with roast lamb?"*
- Language switching mid-conversation: ask something in Russian, then continue in Romanian, then ask for an English summary — it should follow you without being told to switch. Use the language dropdown to pin a specific language instead of relying on auto-detect.

## Connecting an avatar provider (not enabled by default)

Avatars are intentionally **out of scope for this first version** — the dashboard ships with `src/avatar/providers/mockAvatarProvider.js` (a status-only stand-in, no external service, no cost) behind the `AvatarProvider` interface in `src/avatar/AvatarProvider.js`. To add a real avatar later, implement that interface in `src/avatar/providers/<name>AvatarProvider.js` and point `AVATAR_PROVIDER`/`AVATAR_API_KEY` at it — no changes to the realtime core are required.

## Diagnosing common issues

| Symptom | Likely cause |
| --- | --- |
| Dashboard loads but voice/text replies fail with a 503-style error in the event log | `REALTIME_PROVIDER=gemini` but `GEMINI_API_KEY` is missing/invalid |
| Only a synthetic tone plays back, no real answer | `REALTIME_PROVIDER=mock` — this is expected in mock mode, not a bug |
| "Hold to talk" does nothing | Browser denied microphone permission, or you're on `http://` from a non-`localhost` host (browsers require a secure context for `getUserMedia` off localhost) |
| Knowledge tab shows 0 documents/chunks | Run `npm run knowledge:index` |
| A factual question gets a vague/"I don't have data" answer | Expected, honest behavior when nothing relevant is in the knowledge base — add a source document and re-index rather than treating it as a bug |

## Tests

```bash
npm test         # unit + in-process integration tests (tests/*.test.js)
npm run test:smoke  # black-box smoke tests against a real spawned server process
npm run lint
npm run typecheck
```

See `AGENTS.md` for the full required-verification list and the standing architecture rules (independence from the origin project, no hidden preload/monkey-patch, push-to-talk not open-mic VAD in v1, etc).

## Limitations of this first version

- **Push-to-talk, not open-mic VAD.** Barge-in works via the interrupt button/command, but there is no automatic voice-activity detection listening continuously — see `docs/WINE_AI_MIGRATION_PLAN.md` section 5 (risk #2) for why this was the deliberate v1 choice.
- **No session resumption on reconnect.** Each new WebSocket connection starts a fresh session; conversation context does not survive a dropped connection.
- **No persistent memory across sessions.** `src/memory/sessionMemory.js` only lives for the current WebSocket connection — nothing is saved between visits or across users, by design (see Stage 9 of the product spec).
- **No real avatar in v1** — see above.
- **Knowledge base starts small**, but now grows via upload (dashboard drag-and-drop) and an automated crawler (`docs/KNOWLEDGE_PIPELINE_ARCHITECTURE.md`) over a verified source registry — still not a comprehensive database.
- **Retrieval is keyword/term-overlap based, not embeddings-based** — good enough for a focused knowledge base of this size; revisit if/when the corpus grows much larger.
- **Language detection is heuristic**, not model-based — reliable for clear single-language utterances but can stay silent (defer to the last known language) on short or heavily mixed-language input. Use the language dropdown to force a language explicitly if this matters for a demo.
