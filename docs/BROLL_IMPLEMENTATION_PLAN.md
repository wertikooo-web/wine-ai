# B-roll Implementation Plan (draft, for Codex review)

Status: **draft for review, not authorized for implementation**. Written against the actual
codebase (see "Grounding" below), as a response to [`CODEX_BROLL_TASK.md`](CODEX_BROLL_TASK.md).
Codex should treat this as the "author's recommended plan," audit it against the code itself, and
either confirm or correct it before anything gets built.

**Scope note:** this document plans *B-roll* specifically — turn-level (and later,
segment-level) visual illustration of an answer, keyed to `generation_id`. It is deliberately not
a plan for a general "Visual Storytelling" system (scripted multi-scene sequences, cinematic
transitions, per-word choreography). If that broader system is ever wanted, it should be scoped as
its own follow-on effort built on top of this one, not folded in here.

**Revision note:** this draft has been through two review passes — see "Revision log" at the
bottom. Rev 2 changes the recommended order of work: **the narrow next step is now a frontend-only
PoC with static local assets — no migration, no KOS dependency, no storage decision required to
start.** Everything involving `kos_media_assets`, KOS wiring, or the public-bucket decision is
explicitly deferred until that PoC validates the UX is worth building infrastructure for.

## 0. Grounding — what the codebase actually gives us today

This isn't a greenfield design. Two things materially change the plan versus a generic "B-roll for
a voice assistant" writeup:

1. **There is no word/sentence-level timing anywhere in the pipeline today.** Gemini Live's
   `outputTranscription` arrives as text fragments with no offset into the audio; the only timing
   signal is `elapsed_ms` on `audio.start`/`audio.chunk`, which is generation-relative, not
   per-word. `transcript.model` events stream in fragments (`src/realtime/geminiLiveProvider.js`,
   `src/realtime/realtimeServer.js`). Correction from review: this is **not a permanent ceiling on
   the architecture** — it's a statement about the current provider integration, not a proof that
   word-level sync is unreachable. It could become available later via (a) a different/future
   provider that exposes word timestamps, (b) forced alignment run locally against the output
   audio, or (c) a separate TTS pass that does provide timing. None of those exist in this repo
   today, so none of them are part of this plan — but the plan's data model and event shape (see
   §3–4) are kept generic enough not to block that path later.

   For *this* plan, sync is defined in three levels, and only Level 1 is in scope for Phases 0–5:
   - **Level 1 — per reply.** One media set per `turn_id`/`generation_id`. Fully supported by the
     protocol today, zero new provider capability needed. **This is the MVP target.**
   - **Level 2 — per semantic phase.** E.g. intro → winery → bottle → aromas → pairing → CTA.
     Achievable *without* word timestamps if the server pre-plans a visual sequence or emits
     multiple structured cues per turn (see Phase 6 stretch goal) — this is a real, reachable next
     step, not a distant one.
     - **Level 3 — near-real-time with speech.** Forced alignment or a timing-aware TTS. Materially
     more complex, adds latency risk, not justified until Level 1–2 are proven out.

2. **There are two parallel entity systems, and neither is ready as-is.** The live tool-calling
   path (`src/tools/searchWinery.js`, `src/tools/searchWineKnowledge.js`) resolves against a flat
   text-chunk index (`src/knowledge/index.js`) and returns free-text winery names — no stable ID.
   Meanwhile `src/kos/db/kosSchema.js` (Antigravity's in-progress KOS system) already has exactly
   the entity model this feature needs — `kos_wineries.slug`, `kos_wines.slug`, FK relations — plus
   a reusable S3/R2 object-storage abstraction (`src/kos/storage/objectStorage.js`). **But nothing
   in the live conversation path queries KOS today.** Building B-roll on top of the legacy
   free-text tool results means inventing a second, throwaway ID space; building it on top of KOS
   means taking a dependency on a system that's still being built by another dev in the same repo.
   This is the single biggest architectural fork in this plan (see Phase 1 decision below) and is
   exactly the kind of thing Codex should sanity-check against KOS's actual current state before
   we commit.

Everything below assumes the reader has already read `CODEX_BROLL_TASK.md` Parts 1–15; this
document only fills in the "what we'd actually do, in what order" layer on top of it.

## 1. Architectural decision: entity source for Phase 1

**Recommendation: use KOS (`kos_wineries`/`kos_wines`) as the entity space from day one, not the
legacy chunk index.** Reasoning:

- The legacy index has no stable ID — we'd be building a slug system on top of free text
  (`chunk.metadata.winery`), which is exactly the kind of throwaway infra Part-14/Constraint-2 of
  the task brief warns against ("не добавляй новую сложную инфраструктуру только ради B-roll").
- KOS already has the right shape (`slug`, FK winery→wine, provenance). The only missing piece is
  a media table and wiring the live tool path to read from it.
- Risk: KOS is actively under construction by another session in this repo (see the standing
  concurrent-edit note in project memory). **Before Phase 1 starts, confirm with Antigravity /
  check `kos_wineries` row count in the live DB** — if KOS has zero or near-zero real winery rows
  populated yet, B-roll has nothing to key off and Phase 1 should fall back to a **hardcoded slug
  list for 1 demo winery** (see Phase 6 PoC) rather than waiting on KOS population.
- Also confirm (not just row counts) whether `kos_wineries`/`kos_wines` have a publication-status
  concept (`status`/`is_published`), whether the same DB is used locally and on Railway, and
  whether the schema is mid-migration right now — all part of Phase 0, not assumptions to carry
  into Phase 1 unverified.

This is a go/no-go check, not a blocker on writing code — Phase 1's schema work is valid either way.
Phase 0's actual findings are being gathered as this document is written; see the "Phase 0 findings"
section appended near the bottom once available.

**Rev 2 correction (second review pass):** committing to KOS as *the* entity space on day one was
premature — this document's own §11 findings show the live tool-calling path doesn't query KOS at
all today, and no confirmed real winery rows exist in it yet. Recommending KOS as the *target*
architecture is still right; requiring it before anything can be built is not. The fix is a seam,
not a fight between two options:

```ts
interface BrollEntityResolver {
  resolveFromToolResult(toolResult: unknown): Promise<ResolvedBrollEntity | null>;
}
```

First implementation is a tiny whitelist, not KOS: `'castel-mimi' -> winery_demo_castel_mimi`,
matched against whatever free-text winery name `search_winery`'s result already contains today.
When KOS has real, queryable winery rows, a second implementation of the same interface swaps in —
`content.broll.plan`, the resolver contract in §5, and `BrollPlayer` never change. This is the
concrete mechanism that makes "KOS is the target, not a blocker" true in code, not just in
prose.

## 2. Data model additions

New table, modeled directly on `CODEX_BROLL_TASK.md`'s `MediaAsset` type but keyed into KOS.
**Corrected from the first draft**: `kos_wineries.id`/`kos_wines.id` are `TEXT PRIMARY KEY`
(app-generated slug-like strings), **not `uuid`** — confirmed by reading
`src/kos/db/kosSchema.js`'s actual migrations. `entity_id` below is `text` to match.

```sql
CREATE TABLE kos_media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('winery','wine','region','grape')),
  entity_id text NOT NULL,           -- matches kos_wineries.id / kos_wines.id (TEXT, not UUID).
                                      -- FK target depends on entity_type (no single FK possible;
                                      -- enforce via application code + a periodic integrity check,
                                      -- same pattern KOS already uses for polymorphic references)
  media_type text NOT NULL CHECK (media_type IN ('image','video')),
  category text NOT NULL,            -- hero, exterior, cellar, vineyard, bottle, label, map, ...
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','archived')),
  storage_key text NOT NULL,         -- reuses src/kos/storage/objectStorage.js, same convention
                                      -- as kos_source_document_versions.storage_key
  poster_storage_key text,           -- renamed from thumbnail_storage_key: doubles as <video poster>
  orientation text NOT NULL CHECK (orientation IN ('portrait','landscape','square')),
  width integer,
  height integer,
  duration_ms integer,               -- null for images
  file_size_bytes bigint,
  mime_type text,
  checksum text,                     -- sha256 of the stored object, dedupe / integrity check
  alt_text text,                     -- accessibility + fallback label if media fails to load
  language text,
  priority integer NOT NULL DEFAULT 0,
  source_url text,
  copyright_status text,
  valid_from timestamptz,
  valid_until timestamptz,           -- e.g. a seasonal promo asset; resolver excludes expired rows
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON kos_media_assets (entity_type, entity_id) WHERE status = 'approved';
```

`is_approved boolean` from the first draft is replaced with `status` (draft/approved/archived) —
matches the vocabulary KOS already uses elsewhere (`kos_knowledge_sources.status`,
`kos_profile_versions.status`) instead of introducing a boolean where the rest of the schema uses
enums.

**Deliberately not** a generic `metadata jsonb` catch-all — every field the resolver needs
(orientation, category, priority) is a real column so Phase 3's resolver can be a plain indexed
query, not a JSON scan.

**Deferred, explicitly flagged as a temporary tradeoff**: a single `entity_type + entity_id`
polymorphic pair (rather than a separate `kos_media_asset_links` join table) is *accepted* for
Phase 1–5, because most assets belong to exactly one entity and a join table is unjustified
complexity before that stops being true. The moment a real case shows up where one asset needs to
serve multiple entities at once (e.g. one vineyard-drone shot used for both a winery page and a
region page), that's the trigger to add `kos_media_asset_links(media_asset_id, entity_type,
entity_id)` and drop the columns above — not before. Recorded here so this isn't silently
forgotten as "the design."

**Rev 2 addendum — a second, narrower option surfaced in review:** polymorphic `entity_type` +
`entity_id` with no real FK is fine long-term (more entity types are coming: region, grape), but
it's the wrong choice for the *very first* rows, while KOS itself is still being built and
`kos_wineries`/`kos_wines` rows may be sparse or shifting. For the initial seed data specifically,
prefer two nullable typed columns instead:

```sql
winery_id text REFERENCES kos_wineries(id),
wine_id   text REFERENCES kos_wines(id),
CHECK (num_nonnulls(winery_id, wine_id) = 1)
```

This buys a real FK + a real constraint while the entity space is still small and volatile, at the
cost of a migration later when `region`/`grape` need to be added. **This doesn't need deciding
now** — it only matters once schema/migration work actually starts (Phase 3 in the reordered plan
below), and by then Phase 0A/0B will have more information about how volatile KOS's winery rows
actually are. Noted here so the choice isn't made by default inertia when that phase starts.

## 3. New WS event: `content.broll.plan`

**Renamed from `content.broll` in Rev 2**, and split into two distinct concerns that the first
draft conflated: *deciding* what media applies to this turn (can happen as soon as a tool call
resolves an entity) versus *starting playback* (must wait for the assistant to actually be
speaking). The event is now explicitly a **plan**, not a play command — see the timing fix below
this section for why that distinction matters.

Mirrors the existing `tool.call`/`tool.response` emission pattern in `realtimeServer.js` — same
`emitProviderEvent()` helper, so it's free-riding on the already-solid turn/generation-id
plumbing:

```json
{
  "type": "content.broll.plan",
  "protocol_version": 1,
  "session_id": "session_1",
  "turn_id": "turn_42",
  "generation_id": "generation_87",
  "cue_set_id": "cue_set_12",
  "replace_mode": "replace",
  "entity": { "type": "winery", "id": "castel-mimi", "slug": "castel-mimi" },
  "items": [
    {
      "sequence": 0,
      "media_asset_id": "…",
      "media_type": "video",
      "category": "exterior",
      "url": "https://media.wine-ai.md/…",
      "poster_url": "https://media.wine-ai.md/….jpg",
      "duration_ms": 6000
    }
  ]
}
```

Added in Rev 2, per second review: `session_id` (some events in this protocol already carry it
via `emit()`'s auto-fields — made explicit here rather than assumed); `cue_set_id`, a unique id
for *this specific plan*, distinct from `generation_id` — needed once a single generation can emit
more than one plan (Level 2, multiple semantic phases) and analytics/replay logic needs to
distinguish "the 2nd cue set of generation X" from "generation X repeated"; `sequence` on each
item, so ordering survives even if items arrive or get processed out of order; `replace_mode`
(`replace` | `append` | `update_phase` for now) — the frontend queue needs to know *how* a new plan
relates to whatever it's currently showing, not just that a new one arrived. This is what actually
makes the Level-2 claim in §0 true in the protocol, not just in prose — the first draft asserted
"no redesign needed" without the fields to back it.

Kept from Rev 1: `protocol_version` (start at `1`); an explicit `entity` object (not just buried in
each item) so analytics can log "this reply was about winery X" even before per-item resolution;
`snake_case` fields throughout, matching every other event in this protocol.

Client-side rule, non-negotiable: **any `content.broll.plan` payload whose `generation_id` doesn't
match the currently-active generation is discarded on arrival.** This is the same guard the task
brief describes in Part 6, and the ID already exists for free — no new correlation mechanism
needed. On `response.cancelled`/`response.failed`, the frontend clears the active B-roll queue the
same tick it calls `clearPlayback()` (`dashboard.html`, existing handler) — one extra function
call, not a new lifecycle.

### Timing fix (Rev 2): plan early, display late

Second review caught a real bug in the Rev 1 design: emitting the plan "alongside `tool.response`"
means the video can start showing **before the model has said anything about that entity** — a
tool call can resolve Castel Mimi while the model is still saying "sure, let's figure out what you
like first," and the B-roll would jump the gun. The event is data, not a display trigger. The
frontend does not call `BrollPlayer.show()` the instant `content.broll.plan` arrives — it caches
the plan against its `generation_id` and starts playback on whichever of these fires first for
that same generation:

- the first `transcript.model` fragment for that generation, or
- an `audio.start` event, or
- (fallback, if neither fires within ~1.5s of the plan arriving — shouldn't normally happen given
  the realtime pipeline's own latency) a short timer, so a plan is never silently stranded.

This costs one small state variable client-side (`pendingBrollPlan` keyed by `generation_id`) and
no server changes beyond the rename — worth calling out as its own fix rather than folding
silently into "Frontend," because it's a correctness fix, not a style change.

This event is deliberately framed as a general **visual-content lifecycle keyed to
`generation_id`**, not a one-off "video player" bolt-on — this generality should exist from Phase
1, not be retrofitted later once Level 2 (semantic-phase cues, multiple plans per turn) shows up.

## 4. Where cues come from (server-side)

Reject Task Brief's "Подход A" (LLM emits cues inline in its answer) outright — Gemini Live's
output here is a live TTS transcript stream, not a structured-output channel; forcing JSON through
it would corrupt the spoken response. This was already implicitly ruled out by the brief's own
Part 4 framing, but worth stating plainly as a hard no, not just a discouraged option.

**Recommendation: Подход C (rule-based, driven off tool-call results), no LLM in the loop at all
for Phase 1–3.** Concretely:

- `src/tools/searchWinery.js` already runs *inside* the tool-handler flow, which already fires
  `tool.call`/`tool.response` events. Add one more emission right there: pass the tool result
  through the `BrollEntityResolver.resolveFromToolResult()` seam from §1 (whitelist adapter for
  now, KOS-backed later), and if it resolves an entity, look up media for it (highest-priority
  `approved` rows per category, capped at ~3 items) and emit `content.broll.plan` alongside the
  existing `tool.response` — cached client-side, not shown yet (see §3's timing fix).
- This is fully deterministic, adds one DB query per tool call, and requires zero changes to the
  Gemini prompt or response format — the exact "don't touch the realtime core" constraint from the
  task brief (Ограничение 1).
- A later phase could add a small non-LLM ranking step (recency, category diversity) — still no
  model call, just sorting logic in the resolver.

## 5. Media Resolver — fallback chain

Implemented as a plain function in a new module (e.g. `src/kos/media/resolveMediaForEntity.js`),
called from the tool-handler hook above. Signature (per review):

```ts
resolveMediaForEntity({
  entityType,   // 'winery' | 'wine' | 'region' | 'grape'
  entityId,
  categories,   // optional filter, e.g. ['exterior','cellar']
  orientation,  // 'portrait' | 'landscape' — caller passes the client's screen shape
  limit,        // cap, default ~3
  locale,       // prefer language-matched assets, don't hard-require them
})
```

Fallback chain:

```
wine-level match → winery-level match → region-level match → generic "wine" category fallback → none
```

Requirements, made explicit per review (not just "return the right rows"):

- returns only `status = 'approved'` rows;
- sorts by `priority` (desc);
- excludes rows outside `[valid_from, valid_until]`;
- respects `orientation` (a landscape-only asset shouldn't be forced onto a portrait kiosk screen);
- de-duplicates (same `media_asset_id` never appears twice in one response);
- caps result count at `limit`;
- **never throws** — a storage/DB error inside the resolver resolves to "no media for this turn,"
  logged, not propagated; the calling tool-handler must not let a resolver failure affect the
  voice response in any way.

No cross-entity guessing beyond the explicit fallback chain (task brief Part 4 / Constraint 5:
never show media not tied to a verified entity) — and critically, **the generic "wine" fallback
tier must be visually/contextually generic enough that it cannot look like a specific winery's
own photo** (e.g. a neutral vineyard stock shot, not another winery's labeled bottle) — the review
flagged this as a real correctness risk, not just a nice-to-have. If the chain bottoms out,
`content.broll.plan` simply isn't emitted for that turn — the avatar/voice response proceeds exactly as
it does today. This is the mechanism that satisfies the brief's "voice must never depend on B-roll
succeeding" principle end-to-end: the resolver either returns something or returns nothing, never
an error the caller has to handle specially.

## 6. Frontend

New DOM: a `#brollLayer` sibling to `#avatarBox` inside `.device-stage` (`public/dashboard.html`,
same phone-shell markup block the reply-box lives in now). Reuses the `DeviceVisual.setState()`
pattern already in the file rather than inventing a second state machine — B-roll visibility is
driven by the same `speaking`/`ready`/`error` states, just adding one more DOM update inside the
existing `setState()` switch.

`handleEvent()` gets one new case:

```js
case 'content.broll.plan':
  if (payload.generation_id !== currentGenerationId) break; // stale, discard
  pendingBrollPlan = payload; // cached, not shown — see §3 "Timing fix"
  break;
// existing transcript.model / audio.start handlers additionally check
// `if (pendingBrollPlan) { BrollPlayer.show(pendingBrollPlan); pendingBrollPlan = null; }`
```

**Per review, `BrollPlayer` is a standalone module file — `public/js/broll-player.js` — loaded via
`<script src>` from `dashboard.html`, not a block of inline timers embedded in the existing
59KB+ inline `<script>`.** dashboard.html is already large enough that new self-contained
behavior should get its own file; `handleEvent()`'s new case just calls into it.

Minimal public API:

```js
BrollPlayer.show(payload);            // payload = the cached content.broll.plan event
BrollPlayer.cancel(generationId);     // no-op if generationId isn't the one currently showing
BrollPlayer.clear();                  // immediate teardown, any reason
BrollPlayer.destroy();                // full cleanup on page unload/disconnect
```

Requirements (per review — these are what make it production-safe, not just "plays videos"):

- only ever renders items for the currently-active `generation_id`; a late-arriving
  `content.broll.plan` for an already-superseded generation is a silent no-op, not a queued item;
- every `setTimeout`/`setInterval` it creates is tracked and explicitly cleared on `cancel`/
  `clear`/`destroy` — no orphaned timers firing into a torn-down DOM;
- video elements are paused and their `src` cleared (`video.removeAttribute('src');
  video.load();`) on teardown, not just hidden — avoids the classic "video keeps decoding in the
  background" leak;
- all event listeners it attaches are removed on `destroy`;
- respects `prefers-reduced-motion` — reduces to a static poster/first-frame image instead of
  autoplay video when the user has that OS setting on;
- has an image fallback if a video fails to load (`onerror` → swap to `poster_url` and treat as an
  image item rather than blanking the slot);
- survives a duplicate/repeated event for the same `generation_id` without re-triggering playback
  from scratch (idempotent `show()`).

Image/video swap on a fixed timer per item (`duration_ms`), `<video autoplay muted playsInline>`
for video items (autoplay-without-audio sidesteps the mobile autoplay restriction the task brief
flags in Part 10), preloads only the *next* item, not the whole queue. `cancel()`/`clear()` is
called immediately on `response.cancelled`/`response.failed`/new `input_audio.start` (barge-in) —
same tick as the existing `clearPlayback()`.

Display mode for MVP: **Avatar First** (task brief Mode A) — B-roll renders as a card beside/behind
the avatar, not full-screen. Reasoning: dashboard.html's phone-shell layout is fixed at a small
viewport size already (mobile-first), and full-screen takeover would fight the existing
reply-box/text-input UI that was just shipped. Split-screen or full-screen modes are a later,
separate design pass, not part of this plan.

## 7. Content pipeline / admin

Out of scope through the phase table below. `kos_media_assets` rows can be inserted directly via
SQL for the PoC (one winery, ~10 files) — building dashboard upload UI for this is real but
separable work, sequenced after the runtime plumbing proves out (matches task brief's own Этап 5
ordering).

## 8. Phased plan (reordered in Rev 2)

**Rev 2 reorders this table.** The first draft put schema/KOS/storage work before anything
user-visible existed — meaning we'd build infrastructure before knowing whether B-roll next to the
avatar even feels good in this specific UI. Second review's point stands: prove the UX cheaply
first, with zero database/storage dependencies, then build the real pipeline only once that's
validated. Nothing in Phase 1 (the PoC) below requires a migration, KOS, or a storage decision to
start.

| Phase | Scope | New/changed files | Depends on |
|---|---|---|---|
| **0A** | Live entity-flow audit: exactly where does a tool call resolve a winery today, where does that identity get lost before reaching the WS layer, is orientation ever known server-side, can one response involve multiple tool calls / multiple entities, how does provider-switch affect this. Output: a one-page trace, `searchWinery result -> normalized entity -> generation context -> broll plan`, with concrete function names at each arrow. | none (investigation only) | — |
| **0B** | Media delivery decision: pick one of {public R2/CDN bucket for `approved` B-roll only, kept separate from private KOS document storage} vs {authenticated proxy route} — see recommendation below. Record bucket policy, CORS, cache headers, naming convention, max file size, supported formats as a short decision doc. | none (decision + doc) | — |
| **1** | **Frontend-only PoC.** Static local JSON (no DB), one demo winery, one hardcoded `generation_id`-shaped fixture, 3–5 local image/video files in `public/`. Hand-fire a fake `content.broll.plan` event (a debug button or console call) into the existing `handleEvent()` path. Build `#brollLayer` + `BrollPlayer` module against this fixture data. Validate: does it look right next to the avatar, does barge-in cleanly clear it, does reconnect leave no ghosts, does cleanup actually free resources. | `public/js/broll-player.js` (new), `public/dashboard.html` (new DOM + `handleEvent` case + a few fixture/debug lines removed before this ships past PoC) | — (parallel to 0A/0B) |
| **2** | Formalize the `content.broll.plan` event contract (§3) for real — confirm field names against whatever event conventions Antigravity may be introducing for KOS, lock `protocol_version: 1`. | doc only, or a shared JSON-schema/type file if one already exists in the repo for other events | Phase 0A, Phase 1 |
| **3** | Media Registry: `kos_media_assets` migration (typed `winery_id`/`wine_id` columns per §2's Rev-2 addendum, revisit polymorphic later) + manually seed ~10-15 approved assets for the same demo winery into whichever storage Phase 0B chose + `resolveMediaForEntity.js` resolver (§5). | new KOS migration file, `src/kos/media/resolveMediaForEntity.js` (new) | Phase 0A, Phase 0B, Phase 2 |
| **4** | Live tool integration: wire `BrollEntityResolver` (§1) — whitelist implementation first — into `src/tools/searchWinery.js`'s handler flow to actually emit `content.broll.plan` from a real conversation, replacing Phase 1's fixture data. | `src/tools/index.js` or `src/tools/searchWinery.js` (hook point), `src/realtime/realtimeServer.js` (confirm `emitProviderEvent` accepts the new event type) | Phase 3 |
| **5** | Manual smoke test against the real pipeline — see expanded scenario list below | none (testing) | Phase 4 |
| **6** | Only after Phase 5 signs off: swap the whitelist resolver for a KOS-backed one (once Phase 0A/live-KOS-population questions are answered), expand asset coverage, consider dashboard upload UI, consider Level-2 semantic-phase cues | — | Phase 5 |

**Media delivery recommendation for Phase 0B** (per second review): a **separate public
bucket/CDN namespace for `approved` B-roll only**, kept apart from the existing private KOS
document storage. Reasoning against the alternatives — signed URLs add expiry-during-idle-session
complexity for content that's just public marketing material anyway (no reason to gate it), and a
server-side proxy route would make Railway pay bandwidth/connection cost for video streaming,
which degrades badly under load. Source documents (crawled HTML/PDF) correctly stay private and
signed; B-roll media is a different trust category and shouldn't share infrastructure with it just
because `objectStorage.js` already exists.

Phase 5 smoke scenarios (expanded across both review passes — the original list undersold
reconnect/longevity/provider-switch risk):

1. Ask about the PoC winery by voice → B-roll appears, starting when the assistant actually starts
   answering (not the instant the tool resolves — see §3's timing fix).
2. Ask about it by text → same.
3. Interrupt the assistant mid-answer → video stops immediately, queue clears.
4. Ask about a different winery with no seeded media → voice continues normally, no error, no
   stale B-roll left on screen.
5. Switch realtime provider (this project supports provider switching — confirm B-roll doesn't
   assume Gemini-only event timing).
6. Throttle network (slow 3G) → images/video degrade gracefully, no hung loading state blocking
   the rest of the UI.
7. Force a WebSocket reconnect mid-conversation → no duplicate/ghost B-roll from the old session.
8. Leave the dashboard open and idle for several hours → confirm no memory growth from
   accumulated timers/listeners (this is exactly what `BrollPlayer.destroy()`'s cleanup
   requirements in §6 exist to guarantee — this test is what proves them, not just code review).
9. A single response involves more than one tool call / more than one entity (e.g. user asks to
   compare two wineries) — confirm `cue_set_id`/`replace_mode` behave sanely rather than the two
   plans silently clobbering each other.

Phases 0A/0B/1–5 are the actual MVP / PoC. Nothing past Phase 5 is committed to by this plan.

## 9. Explicit non-goals (carried over from the task brief's constraints, restated against this
   codebase specifically)

- No changes to `src/realtime/geminiLiveProvider.js`'s core turn/generation logic —
  `content.broll.plan` is purely additive, riding the existing `emitProviderEvent()` plumbing.
- No LLM call in the cue-generation path (Phase 1–4). If a later phase wants smarter ordering, that
  stays a non-LLM ranking function, not a second model in the loop.
- No dependency on Gemini providing timestamps it doesn't have — this plan does not block on or
  wait for word-level sync becoming available.
- No new video-generation infra (Veo/Kling/Runway) — everything is pre-shot, pre-approved assets in
  `kos_media_assets`.
- Feature-flaggable: since everything is gated behind "did the tool handler find a matched entity
  with approved assets," the simplest kill switch is an env var checked once in the Phase 3 hook
  (`BROLL_ENABLED=false` short-circuits before the DB query) — no separate flag plumbing needed
  through the WS protocol.

## 9a. Recommended immediate next step (not yet authorized — awaiting explicit go-ahead)

Per second review, the narrowest safe next action is Phase 1 (the frontend-only PoC) plus Phases
0A/0B run in parallel as investigation/decision work — explicitly **excluding** any migration, any
KOS wiring, and any storage change:

1. No migration.
2. No KOS connection.
3. No storage changes.
4. Build the frontend-only PoC with local fixture media (Phase 1).
5. Formalize `content.broll.plan` for real (Phase 2).
6. Verify barge-in, stale-generation discard, reconnect, and cleanup against the PoC (folding
   Phase 5's scenarios 1–4, 7, 8 in early, before any server work exists to test).
7. Separately prepare the Phase 0B public-bucket/CDN decision as a doc, not an implementation.
8. Return with results and the concrete integration points found in Phase 0A before Phase 3+
   starts.

**This document does not authorize starting that work — it's recorded here so the next go-ahead
can point at a specific, already-scoped step instead of re-deriving one.**

## 10. Open questions for Codex to weigh in on before Phase 1 starts

1. Confirm current real state of `kos_wineries`/`kos_wines` population (Phase 0) — this plan's
   Phase 1 entity-space decision hinges on it. **Still open — see §11, could not be answered from
   this environment.**
2. Confirm `src/kos/storage/objectStorage.js`'s `S3StorageAdapter` is safe to reuse for
   publicly-servable media (it was built for internal source documents, not necessarily
   configured for public read / CDN-style access) — may need a separate bucket or public-read
   policy, not just reusing the existing one as-is. **Partially answered — see §11: it's
   confirmed private-by-default with no browser-facing route at all today, which is more work than
   the first draft assumed.**
3. Sanity-check the `content.broll` event shape against whatever event-schema conventions
   Antigravity may already be introducing for KOS-related realtime events, if any — better to align
   naming now than rename later. **Still open.**

## 11. Phase 0 findings (actual, from this environment — not fabricated)

Attempted to run the real Phase-0 queries this plan calls for. Result: **could not get live
database access from this session** — no `.env` file exists in the repo (only `.env.example`, with
`DATABASE_URL` blank), no `.railway` directory, no `railway.json`. This is a genuine gap that has
to be closed by someone with Railway dashboard/CLI access (you, or Antigravity) — not something
resolvable by reading the repo alone. What follows is everything that *could* be determined from
code, clearly marked as code-only, not live-data:

**KOS entity schema — confirmed from `src/kos/db/kosSchema.js` migrations (code, not live data):**
- `kos_wineries.id` and `kos_wines.id` are **`TEXT PRIMARY KEY`, not `uuid`** — the first draft of
  this plan assumed `uuid` (copying the task brief's example types) and that assumption was wrong.
  §2's schema above is corrected to `entity_id text`.
- `kos_wineries.slug` has a real `UNIQUE NOT NULL` constraint plus a supporting index — the slug
  space itself is sound as an entity key.
- **No publication-status column exists on `kos_wineries` or `kos_wines` at all**, across all 4
  migrations. Status/verification concepts exist elsewhere in KOS (`kos_knowledge_sources.status`,
  `kos_knowledge_facts.verification_status`, `kos_profile_versions.status`) but publication state
  lives at the *profile-version* level (`kos_winery_profile_state.active_published_version_id`),
  not per-winery/per-wine. Anything gating B-roll on "is this winery published" needs to join
  through profile state, not a column that doesn't exist on the winery row itself.
- **No seed/fixture data for real wineries found in the repo.** `castel-mimi` appears only as a
  source-registry id (`src/knowledge/sources/registry.js:303`) and as test-fixture ids in
  `tests/kosStep1.test.js` etc. — none of that is evidence of an actual row in a live
  `kos_wineries` table. **This means the Phase-0 go/no-go from §1 is still unresolved**: we don't
  know today whether KOS has any real winery rows to key off, only that the schema supports it.

**Storage adapter — confirmed from `src/kos/storage/objectStorage.js` (code, not live data):**
- **Private by default** — `putObject` sets no ACL at all (no `public-read` anywhere in the file
  or repo-wide), and all read access is mediated through `getSignedUrl`. This confirms Open
  Question 2 above in the more work-required direction: there is currently no path for a browser
  to fetch an object directly.
- `getSignedUrl` exists; default TTL is `S3_SIGNED_URL_TTL_SECONDS`, defaulting to 3600s (1h) if
  unset, hard-capped at 7 days. **This matters for B-roll specifically**: a signed URL handed to
  the client at `content.broll` time could expire mid-session on a long-idle conversation — Phase
  4's frontend should treat a 403 on a media URL as "skip this item," not surface an error, and
  Phase 3 should probably request TTLs long enough to outlive a typical session rather than relying
  on the 1h default.
- **No CORS configuration exists anywhere in the repo** — zero matches for `cors` repo-wide, no
  infra-as-code files at all. If media is ever fetched cross-origin (e.g. served from an R2/CDN
  domain different from the app's own origin), this will need to be set up from scratch — not
  configured today, not a gap in this plan's reading of an existing setup.
- **No route in `src/server.js` currently serves objects from this storage to a browser at all.**
  The only string reference to a download path
  (`/api/kos/sources/download/${key}`, inside `LocalFileStorageAdapter.getSignedUrl`) has **no
  matching route handler anywhere in the repo** — it's a dead link today. Concretely: Phase 3/4 of
  this plan cannot assume "just point an `<img>`/`<video>` at the signed URL and it works" — either
  a new public-read bucket/CDN needs to be provisioned, or a new authenticated proxy route needs to
  be added to `src/server.js`. This is real, unbudgeted scope this plan's phase table doesn't yet
  reflect — flagging rather than quietly absorbing it into an existing phase.
- Endpoint is provider-agnostic in code (`S3_ENDPOINT` accepts any http(s) URL; `S3_FORCE_PATH_STYLE`
  suggests R2/MinIO compatibility was anticipated) but every relevant env var is blank in
  `.env.example` — whether production actually points at AWS S3 or Cloudflare R2 cannot be
  determined from the repo.

**Net effect on this plan:** Phase 0 is not closed. The concrete next action isn't "start Phase 1
schema work" — it's (a) get Railway DB credentials into a session that can query
`kos_wineries`/`kos_wines` row counts directly, and (b) decide, with that answer in hand, whether
media will be served via a new public bucket/CDN or a new authenticated app route, since neither
exists today. Both are yes/no-answerable in one sitting once someone has DB/Railway access — they
are not architecturally hard, just currently unanswered.

## Revision log

- **Rev 1**: incorporated first review pass — (1) reframed "no word-level sync" as
  a current-provider limitation, not a permanent ceiling, and named the three sync levels
  explicitly; (2) added an explicit scope note distancing this plan from a full "Visual
  Storytelling" system; (3) generalized `content.broll` to a visual-content lifecycle keyed on
  `generation_id` from Phase 1, not a single-item bolt-on; (4) ran the actual Phase 0 checks — see
  §11 — and corrected the `uuid`→`text` entity-id mistake it surfaced. Also added: `status` enum
  instead of `is_approved` boolean, deferred `kos_media_asset_links` tradeoff note, extra media
  columns, `protocol_version`/`entity` on the event, `BrollPlayer` as a standalone module with a
  concrete cleanup contract, and expanded Phase 5 smoke scenarios (provider switch, reconnect,
  longevity).
- **Rev 2** (this revision): incorporated second review pass — (1) renamed `content.broll` to
  `content.broll.plan` and fixed a real timing bug: the event is now cached and displayed only
  when the assistant actually starts speaking about the resolved entity, not the instant a tool
  call resolves it; (2) added `session_id`, `cue_set_id`, per-item `sequence`, and `replace_mode`
  to the event so Level-2 multi-cue turns are actually representable, not just claimed to be;
  (3) introduced the `BrollEntityResolver` seam so the very first implementation can be a small
  winery whitelist instead of requiring KOS to be populated first — KOS stays the target
  architecture, not a hard dependency to start; (4) reordered the phase table so a frontend-only
  PoC with local fixture media comes first, before any migration/KOS/storage work, per the
  "validate the UX before building infrastructure" argument; (5) split Phase 0 into 0A (live
  entity-flow trace) and 0B (media-delivery decision, with a concrete recommendation: separate
  public bucket for approved B-roll, kept apart from private KOS document storage); (6) added a
  Rev-2 addendum to the data model favoring typed `winery_id`/`wine_id` columns over the
  polymorphic pair for the *initial* seed rows specifically, while KOS's own entity space is still
  small/volatile; (7) added a 9th Phase-5 smoke scenario for multi-entity responses. Explicitly
  **not yet authorized** — see §9a for the scoped next step this revision recommends, pending a
  separate go-ahead.
