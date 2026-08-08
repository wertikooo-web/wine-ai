# Selective RAG Router — offline design + evaluation

**Status: offline only. Not wired into the live tool path. Not deployed. No flag set in any environment.**

This is a *different and earlier* decision from the Answerability Gate (PR #48).
The gate asks, after retrieval has run, "can this evidence be trusted / may the
assistant answer". This asks, before anything runs, "is retrieval worth doing at
all". The gate is untouched and still applies to every `GROUNDED` turn.

- Router: `src/knowledge/selectiveRagRouter.js` (pure, synchronous, no LLM call)
- Dataset: `experiments/selective-routing/router-dataset.json` (80 items)
- LOOP A / C / weighted error: `eval-offline.js`
- LOOP B (real API): `loop-b.js` (resumable, batched) + `analyze-loop-b.js`
- Step 8 adversarial probe: `principal-review.js`

---

## 1. Baseline (what we do today)

| Metric | Value | Source |
|---|---|---|
| Retrieval rate on substantive queries | ~100% | `classifyQueryIntent()` routes everything except `off_topic_smalltalk` into retrieval, and the tool-calling contract in `searchLayeredKnowledge.js` instructs the model to "Call this before answering any factual question". Measured: the `classifyQueryIntent`-alone baseline sends 190/190 eval turns to retrieval except pure greetings. |
| GROUNDED path latency | **9,632 ms** mean (retrieval 6,711 ms + generation 2,920 ms) | LOOP B, 34 real turns |
| DIRECT path latency | **2,145 ms** mean | LOOP B, 34 real turns |
| GROUNDED prompt tokens | **45,067** mean (33,381 on general queries, 66,492 on entity queries) | LOOP B. Consistent with PR #48's 37,979 mean. |
| DIRECT prompt tokens | **3,900** mean | LOOP B |
| RAG harm rate on router-DIRECT queries | **harmed 6 / neutral 10 / helped 5** (of 21 judged) — retrieval was neutral-or-harmful on **76%** | LOOP B with the Phase 0 parity-fixed judge |
| "Unsupported claims" rate | PR #48 reported ~19–22%. **~85% of that was judge truncation.** | Phase 0 (issue #49), verified by hand |
| Real factual failure rate | **~2.5%** (PR #48 forensic); LOOP B on router-DIRECT turns: **1/21 turns (4.8%)** had any unverified claim, and **0%** attributed a fact to a named producer | Phase 0 + LOOP B |

### The Phase 0 correction (issue #49, separate PR)

The A/B harness fed the **generator** up to 12 evidence items at full chunk
length but built the **judge** prompt from a display projection truncated to
8 items × 700 chars. Verified by hand against four PR #48-flagged cases:

| case | generator saw | old judge saw | hidden |
|---|---|---|---|
| q070 | 131,726 chars (12 items) | 5,607 | 95.7% |
| q050 | 111,529 chars (12 items) | 5,607 | 95.0% |
| q049 | 130,522 chars (8 items) | 5,607 | 95.7% |
| q054 | 79,234 chars (8 items) | 5,607 | 92.9% |

10 of 17 checked claim fragments — the Negru de Purcari 55/40/5 blend, the
Cricova gallery length, the Vinaria din Vale Saperavi/Decanter results — are
present in the generator's evidence and absent from the truncated judge view.
They were graded as invented facts purely because the judge could not see them.

In LOOP B the parity-fixed judge saw a mean of **10.47 items / 63,367 chars**
per turn, versus the 5,607-char ceiling the old harness imposed.

---

## 2. The decision graph, as actually implemented

Evaluated in order; the first node that returns a decision wins. Every node is
a named function in `selectiveRagRouter.js`. Order is load-bearing and asserted
by `NODE_ORDER`.

```
routeSelective(query, { recentTurns })
  │  ctx = { query, norm, entity: resolveEntity(query), wineTopic, isPairing, recentTurns }
  │
  ├─ N1  CURRENT_DATA ──────────────── YES ─→ GROUNDED (0.99)
  │      isCatalogQuery(q) || isFreshnessQuery(q)
  │      (guarded: `бутылк`/`фото`/`открыт`/`час` alone do not count)
  ├─ N2  OUR_INVENTORY ─────────────── YES ─→ GROUNDED (0.97)
  │      OUR_INVENTORY_RE  "что у вас есть", "из вашего ассортимента"
  ├─ N2b VISIT_LOGISTICS ───────────── YES ─→ GROUNDED (0.94)
  │      VISIT_LOGISTICS_RE  tours, tastings, booking, getting there
  ├─ N2c LOCAL_GRAPE_VARIETY ───────── YES ─→ GROUNDED (0.86)
  │      LOCAL_GRAPE_VARIETY_RE  indigenous Moldovan varieties
  ├─ N3  ENTITY_REFERENCE ──────────── YES ─→ GROUNDED (0.96)
  │      resolveEntity(q).found  — the 109-entity registry, fuzzy, typo-tolerant
  ├─ N4  UNKNOWN_PROPER_ENTITY ─────── YES ─→ GROUNDED (0.90)
  │      looksLikeUnknownProperEntityStrict(q)
  ├─ N5  SPECIFIC_ATTRIBUTE ────────── YES ─→ GROUNDED (0.92)
  │      SPECIFIC_ATTRIBUTE_RE, minus a bounded explanation exemption
  ├─ N6  CONVERSATION_ENTITY_CONTEXT ─ YES ─→ GROUNDED (0.93 / 0.80 / 0.72)
  │      referent-dependent AND recentTurns non-empty
  ├─ N7  SMALLTALK ─────────────────── YES ─→ DIRECT   (0.94)
  ├─ N8  GENERAL_WINE_KNOWLEDGE ────── YES ─→ DIRECT   (0.88 / 0.85)
  │      wineTopic AND (explanation-shaped OR pairing)
  ├─ N8b GENERAL_WINE_KNOWLEDGE_IMPLICIT ─ YES ─→ DIRECT (0.80)
  │      pairing with no wine vocabulary ("Что подать к стейку?")
  └─ N9  AMBIGUOUS (terminal) ──────────────→ GROUNDED (0.50)
```

`routeSelective` returns `{ path: 'DIRECT'|'GROUNDED', reason, entity, confidence }`.
It **never** returns `AMBIGUOUS`; there is an explicit invariant check that
downgrades any non-DIRECT/GROUNDED node output to GROUNDED.

### Why each node exists — with the number that justifies it

| Node | Exact condition (code) | Why it exists |
|---|---|---|
| **N1 CURRENT_DATA** | `isCatalogQuery(q) \|\| isFreshnessQuery(q)`, guarded by `CATALOG_SOFT_STEMS_RE`/`FRESHNESS_SOFT_STEMS_RE` | All 7 `price_stock` and 8 `commercial_current` items route correctly (15/15). It must run first: `Сколько стоит Negru de Purcari 2019?` is a price question before it is an entity question. The guards were added because `бутылк` and `открыт` made `Как хранить открытую бутылку вина?` a false GROUNDED (P28). |
| **N2 OUR_INVENTORY** | `OUR_INVENTORY_RE.test(norm)` | `isCatalogQuery` only knows price/stock vocabulary, so `Что из вашего ассортимента подойдёт к стейку?` read as a generic pairing question — a false DIRECT on a question that asks us to name bottles we stock. 3/3 `our_inventory` items now correct. |
| **N2b VISIT_LOGISTICS** | `VISIT_LOGISTICS_RE.test(norm)` | Added after LOOP A: `Нужно ли бронировать визит на молдавскую винодельню заранее?` (q083) was the one false DIRECT with an operational consequence — wrong booking advice sends a user to a closed gate. `winery_tourism` went 6/7 → 7/7. |
| **N2c LOCAL_GRAPE_VARIETY** | `LOCAL_GRAPE_VARIETY_RE.test(norm)` | **Added because of a measured LOOP B failure, not intuition.** DIRECT answers about *international* varieties scored factuality 4.9–5.0 with zero unverified claims. The single factual failure in the entire DIRECT sample was r013 `Расскажи о сорте Виорика`: factuality 3, two invented parentage claims (`Сейв Виллар 20-366`, `Мускат де Гамбург`). This node dropped combined false-DIRECTs from 4 to 1 and the weighted error from 54 to 24. |
| **N3 ENTITY_REFERENCE** | `resolveEntity(q).found` | The dominant grounding signal: **51 of 190** combined turns route here. All 10 `known_entity`, all 6 `typo_entity`, all 13 `moldova_specific`, all 9 `product_facts` items are correct. The registry is also the only signal that survives typos — `Пуркари`, `Purkari`, `Krikova`, `Милештий Мичь` all resolve where a substring match would not (6/6 typo cases). Deliberately unconditional, including for comparative phrasings: `Какие вина обычно легче — Purcari или обычные молдавские?` (P22) still grounds, because any answer to it makes an attributed claim about a named producer. |
| **N4 UNKNOWN_PROPER_ENTITY** | `looksLikeUnknownProperEntityStrict(q)` | The registry holds 109 entities; Moldova has hundreds of producers. **8/8** invented producers (`Crama Solaris`, `Vinăria Nistrului`, `Domeniile Rosu`, `Terra Aurelia`, …) are caught. Without it, these are the highest-severity false DIRECT possible — the model narrates the history of a winery that does not exist. Re-implemented stricter than the shared version on two points that only matter pre-retrieval: sentence-initial capitals after `.!?` are skipped (`Привет! Как дела?` was reading `Как` as a producer), and a quoted span counts only if capitalised (`«терруар»`, `«ножки»` are quoted common nouns). |
| **N5 SPECIFIC_ATTRIBUTE** | `SPECIFIC_ATTRIBUTE_RE.test(norm)`, exempting explanation-shaped, digit-free, wine-topical queries | All 8 `product_attribute` items correct. The exemption exists because `Что даёт вину выдержка в дубовой бочке?` matched `выдерж` and grounded a pure education question. The exemption is safe *because of node order*: N3 and N4 have already declined, so the query provably names nothing. The digit test keeps it honest — `Почему урожай 2019 считается лучшим?` contains a number, so it stays GROUNDED. |
| **N6 CONVERSATION_ENTITY_CONTEXT** | `looksReferentDependent(q) && recentTurns.length` → resolve entity from prior user turns | Reuses the **existing** `recentTurns` array from `toolContext` — no new memory system. All 8 legacy `followup_multiturn` and all 5 router `multiturn` items correct. `А сколько это стоит?` after a Purcari turn inherits the entity (P17); `А какое из них легче?` after a Fautor turn resolves the referent (P18). Two corrections were required: `такое` had to leave the pronoun list (it made every `Что такое танины?` look like a follow-up), and the node must not fire with empty history — on turn 1 a pronoun is non-anaphoric (`всегда ли это нужно?`). Those two fixes alone removed 10 false GROUNDEDs. |
| **N7 SMALLTALK** | `SMALLTALK_RE.test(q.trim())` | 3/3. Runs *after* every grounding node so `Привет! Сколько стоит Negru de Purcari?` still grounds. The regex deliberately has no trailing `\b`: JS word boundaries are ASCII-oriented, so `спасибо\b` does not match `Спасибо,` — this module hit that exact bug. |
| **N8 / N8b GENERAL_WINE_KNOWLEDGE** | `wineTopic && (GENERAL_EXPLANATION_RE \|\| GENERAL_EXPLANATION_EXTRA_RE \|\| isPairing)` | The only node that can return DIRECT for a factual question, and it runs last, so by construction the query names no entity, no unknown proper noun, asks no checkable attribute, has no freshness/inventory/visit framing and no dangling referent. This is where the entire 24.7% DIRECT rate comes from. Moldovan-dish pairings are excluded (`LOCAL_CUISINE_RE`) because in this product `Какое вино подать к мамалыге с брынзой?` is really "recommend from our Moldovan range" — that exclusion fixed 2 false DIRECTs (q018, q022). |
| **N9 AMBIGUOUS** | terminal | 20 of 190 turns land here, all → GROUNDED. `Посоветуй что-нибудь недорогое к ужину.` (P21) has no entity, no price word and no explanation shape — it is exactly the case where "not sure" must cost latency, not accuracy. |

---

## 3. Offline eval (LOOP A)

| Dataset | n turns | Accuracy | false DIRECT | false GROUNDED | DIRECT rate |
|---|---|---|---|---|---|
| Legacy 110 (untouched, prior sprint labels) | 110 | **94.5%** | **1** | 5 | 24.5% |
| Router-specific 80 (new) | 80 | **97.5%** | **0** | 2 | 25.0% |
| **Combined** | **190** | **95.8%** | **1** | 7 | **24.7%** |

Perfect (0 error) categories: `known_entity` 10/10, `typo_entity` 6/6,
`unknown_entity` 8/8, `product_attribute` 8/8, `product_facts` 9/9,
`price_stock` 7/7, `commercial_current` 8/8, `commercial_framing` 3/3,
`our_inventory` 3/3, `mixed_ambiguous` 5/5, `moldova_specific` 13/13,
`tricky_looks_general` 10/10, `followup_multiturn` 8/8, `multiturn` 5/5,
`preference_matching` 8/8, `winery_tourism` 7/7, `smalltalk` 3/3.

**The single remaining false DIRECT** is q044 `Почему молдавское виноделие
считают недооценённым?` — an opinion/essay question naming no producer, no
price and no product. It is not a severity-10 class.

---

## 4. Weighted error (severity: false DIRECT = 10, false GROUNDED = 2)

| Scorer | Legacy 110 | Router 80 | **Combined** |
|---|---|---|---|
| **selectiveRagRouter** | **20** | **4** | **24** |
| baseline (a): always GROUNDED — today's de facto behaviour | 62 | 44 | **106** |
| baseline (b): `classifyQueryIntent()` alone | 94 | 96 | **190** |

The router beats "always GROUNDED" by **4.4×** and `classifyQueryIntent` by
**7.9×**. On the false-DIRECT-weighted component specifically: router 10,
always-GROUNDED 0, intent-only 100. The router pays 10 points of false-DIRECT
risk to remove 92 points of always-GROUNDED waste; `classifyQueryIntent` alone
takes 10× the false-DIRECT risk for less benefit, which is why it cannot be
used as a selective-routing signal on its own.

---

## 5. Answer quality (LOOP B) — 32 items / 34 turns, real Gemini, parity-fixed judge

### Where the router chose DIRECT (22 turns)

| | quality | factuality | relevance | naturalness | % answers with any unverified claim | % attributing a fact to a named producer |
|---|---|---|---|---|---|---|
| **DIRECT** (what we'd ship) | **4.52** | 4.86 | 5.00 | **5.00** | 9.5% | **0%** |
| GROUNDED (counterfactual) | 4.24 | 4.90 | 4.90 | 4.81 | 9.5% | **0%** |

DIRECT is **better on quality (+0.28) and naturalness (+0.19)**, statistically
indistinguishable on factuality (−0.04), and identical on producer attribution
(0% both). Judge verdict: **DIRECT_SUFFICIENT on 17/21**. Retrieval effect:
**harmed 6, neutral 10, helped 5** — retrieval was neutral-or-harmful on 76% of
the queries the router routes DIRECT.

### Where the router chose GROUNDED (12 turns) — validating the other half

| | quality | factuality | mean unverified claims | % attributing a fact to a named producer |
|---|---|---|---|---|
| DIRECT (counterfactual — what we'd have shipped if the router were wrong) | 3.82 | 4.09 | 1.91 | **90.9%** |
| **GROUNDED** (what we'd ship) | **4.45** | **5.00** | 1.64 | 72.7% |

This is the decisive result. **The two classes separate cleanly on the
safety-critical metric: 0% producer attribution on the DIRECT side, 90.9% on
the GROUNDED side.** The router is not just matching labels — it is separating
the queries where skipping retrieval is free from the queries where skipping it
would make the assistant attribute an unverified fact to a real producer nine
times out of ten. Judge preferred the grounded answer on 8/11 of those.

---

## 6. Latency

| Path | Mean |
|---|---|
| **Router decision itself** | **p50 1.47 ms, p95 3.55 ms, p99 7.12 ms** (38,000 real calls) |
| DIRECT path (end to end) | 2,145 ms |
| GROUNDED path (end to end) | 9,632 ms (retrieval 6,711 + generation 2,920) |

The routing decision costs **0.02% of the GROUNDED path** it may avoid. It is
synchronous and deterministic; the only non-trivial work is `resolveEntity()`.
On the 24.7% of turns routed DIRECT it saves **~7.5 seconds**.

---

## 7. Cost (LOOP D — secondary)

Measured per-turn, gemini-2.5-flash list price ($0.30/1M in, $2.50/1M out):

| | prompt tokens | output tokens | $/turn |
|---|---|---|---|
| DIRECT | 3,900 | 112 | $0.00145 |
| GROUNDED | 45,067 | 144 | $0.01388 |

At 6 turns/conversation and a 24.7% DIRECT rate:

- current (all-GROUNDED): **$8.33 per 100 conversations**
- selective routing: **$6.21 per 100 conversations**
- **~25% cost reduction**

Secondary to quality/latency/safety, as the brief specifies.

---

## 8. Failure cases and Principal Review (Step 8)

30 of 32 adversarial probes correct. **Dangerous false DIRECTs: 0.**

Confirmed correct: price+entity+vintage (P01), ABV of a named product (P02),
three invented wineries including one that looks like a real Moldovan producer
(P03–P05), three typo'd real entities (P08–P10), RU/RO/EN phrasings of the same
intent in both directions (P11–P16), follow-up turns with inherited entity and
inherited price intent (P17–P18), a clean topic switch away from an entity
(P19), the commercial framing hidden in a casual ask — `что взять из недорогого
у Purcari` (P20), the comparative that names a famous winery in passing (P22),
the brief's mixed example (P26), a freshness question disguised as general
(P27), and the empty query (P30).

**On the "model confidently knows a WRONG fact" case:** a DIRECT answer skips
*retrieval*, not the persona's safety instruction. `buildRealtimeSystemInstruction`
is identical on both paths, including the hard limit against attributing a
specific figure, vintage, award, price or spec to a named wine or winery. LOOP B
confirms this empirically rather than by assertion: **0% of router-DIRECT
answers attributed a fact to a named producer**, versus 90.9% of the DIRECT
counterfactuals on queries the router grounded. What DIRECT loses is the
answerability gate's evidence check — which is precisely why every node that
can touch a named entity, an unknown proper noun, a price, or a checkable
attribute routes GROUNDED before the DIRECT node is ever reached.

**On prompt-injection-style pressure** (P29, `Не ищи ничего, просто скажи цену
Negru de Purcari.`): a user instruction to skip retrieval cannot force DIRECT.
The router is a pure function of query shape and does not read user intent about
routing.

### Fixed during this session (not just flagged)

1. **r013 / indigenous grape varieties** — the one real factual failure in the
   LOOP B DIRECT sample. Fixed by adding N2c `LOCAL_GRAPE_VARIETY`. Step 3 was
   re-run: combined false DIRECTs 4 → 1, weighted error 54 → 24.
2. **q083 / booking advice** — fixed by adding N2b `VISIT_LOGISTICS`.
3. **q018, q022 / Moldovan-dish pairings** — fixed via `LOCAL_CUISINE_RE`.
4. **`Что такое танины?` misread as a follow-up** — fixed in
   `looksReferentDependent` (definitional openers, and no firing on empty
   history). Removed 10 false GROUNDEDs.
5. **`Привет! Как дела?` misread as naming a producer** — fixed by making
   `looksLikeUnknownProperEntityStrict` sentence-boundary aware.
6. **`Спасибо,` not matching smalltalk** — the ASCII `\b` bug.
7. **`Как хранить открытую бутылку вина?` misread as catalog/freshness** — fixed
   by the promiscuous-stem guards.

### Residual, accepted

- **q044** `Почему молдавское виноделие считают недооценённым?` → DIRECT.
  Opinion/essay, no producer, no price, no product. Severity is low; flagged for
  shadow-mode observation rather than another regex.
- **P06/P07** `Grand Cru` / `Methode Traditionnelle` → GROUNDED. Classification
  terms that do not register as wine-topical. **Costs latency only.**
- **7 combined false GROUNDEDs.** All latency-only by construction.
- The 4 indigenous-grape items in `router-dataset.json` were **relabelled**
  DIRECT → GROUNDED after LOOP B. Each carries `original_expected` and a
  `relabel_note` recording why. The justification is external to the router: a
  measured factuality failure on real API calls, plus the prior sprint's
  independent labelling of the same class as `GROUNDING_REQUIRED`.

---

## 9. Verdict: **GO SHADOW**

The offline case is strong on every axis the brief asked about:

- **Safety** — 1 false DIRECT in 190 turns, on an opinion question; 0 dangerous
  false DIRECTs across 32 adversarial probes; 0% producer attribution on the
  DIRECT path against 90.9% on the class the router grounds.
- **Quality** — DIRECT is *better* than GROUNDED on the queries it is chosen
  for (quality +0.28, naturalness +0.19, factuality flat), with the judge
  calling retrieval neutral-or-harmful on 76% of them.
- **Latency** — 1.47 ms to save 7.5 s on a quarter of turns.
- **Weighted error** — 4.4× better than today's behaviour, 7.9× better than the
  only pre-retrieval signal that exists now.
- **Cost** — ~25% reduction, secondary.

**This session's ceiling is GO SHADOW and cannot be higher.** `GO LIMITED` and
`GO PRODUCTION` require shadow-mode data from real production traffic, which
this session deliberately does not produce: no shadow deploy was performed, no
`SELECTIVE_RAG_MODE` was set anywhere, and the router is not wired into
`search_wine_knowledge` even behind a flag. Every number above comes from a
190-turn offline set and a 34-turn real-API sample — enough to justify
*observing* the router against live traffic, not enough to justify *acting* on
it.

Recommended next step (requires a separate explicit GO from the product owner):
deploy shadow mode to staging, log `routeSelective()`'s decision alongside the
decision actually taken, change no behaviour, and review the false-DIRECT rate
on real traffic — with q044-style opinion questions and `AMBIGUOUS:default_grounded`
turns as the two things to watch.

**Merge: NOT PERFORMED. Shadow deploy: NOT PERFORMED. Production routing: NOT ENABLED.**
