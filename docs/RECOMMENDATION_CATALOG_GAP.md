# Recommendation catalog gap (organic `recommendWine`)

Status: **open, not fixed**. Found during the Recommendations/News audit, 1 Oct 2026.
It is deliberately left out of the operator-content PR: fixing it changes the whole recommendation output and needs its own regression ticket.

## Finding

WINE AI's organic wine recommendations come almost entirely from six hard-coded Aurelius bottles. They do not come from the WineMD catalog.

### Evidence from code

1. Candidates come from `wineNamesFromEvidence(evidence)` plus `OFFICIAL_BOTTLE_PROFILES`, in `src/knowledge/wineIntelligence.js`, `recommendWine()`.
2. Each candidate needs a style: `wineFacts(name)` → `groundedWineStyle(name, evidence)`. If no style is found, the candidate is skipped (`if (!facts.style) continue;`).
3. `groundedWineStyle` looks in `catalogProfilesFromEvidence(evidence)`, which reads `item.catalog.profile`.
4. **`catalogRowToEvidence` (`src/knowledge/layeredRouter.js`) never sets `catalog.profile`.** It copies product id, entity id, vintage, volume, price, availability and URLs only.
5. The only fallbacks are:
   - `OFFICIAL_BOTTLE_PROFILES` aliases, which cover only the 6 Aurelius wines;
   - an exact style or grape name. A bottle title like "Căinari Fetească Neagră 2023" is not an exact match for "Fetească Neagră".
6. Result: almost every WineMD catalog row is dropped before scoring.
7. A second, smaller limit: `catalogStore.searchCatalog` uses an AND of all query tokens against the title. A request like "посоветуй белое сухое" rarely retrieves any catalog row in the first place.

### What exists but is unused

- `companion_wines` (Postgres) has 444 imported WineMD products. 429 have a price. Each has a type (красное 212, белое 148, розовое 51, сладкое 20, коллекционное 13).
- Explicit `sweetness` is missing on all 444 imported records. Only «сладкое» in `type` states sweetness.
- `src/companion/companionWineFacts.js` (added with operator content) already projects these records onto the fields the engine scores: color, sweetness, price, grapes, food pairings. Today only the promotion layer uses it.

## Impact

Recommendation requests ("посоветуй красное сухое до 300 леев") are answered from a very small candidate pool. The real WineMD range is not used for organic recommendations. This limits the core product, not just the look of the answers.

## Suggested fix path (after launch, separate ticket)

1. Add a candidate source in `recommendWine()`: published `companion_wines` filtered by the request's hard constraints, through `companionWineFacts`. Use the same scorer (`scoreWineCandidate`).
2. Decide the sweetness policy before switching. Almost no records state sweetness, so "сухое" either matches nothing or must accept "unknown". Better: enrich `sweetness` at import time from wine.md product pages.
3. Make budget hard for catalog candidates when the price is known. Organic `-4` today.
4. Diversity and limits: cap candidates per winery so one producer does not fill the top 3.
5. Roll out behind a flag, compare before/after on the recommendation benchmark (`/api/knowledge/benchmark`) and in shadow logs, then switch.
6. Optionally, fill `catalog.profile` in `catalogRowToEvidence` from the same adapter. Do this only together with steps 1–5, since it widens the organic pool just the same.

## Why not now

Today the system recommends from 6 well-tested wines. Opening the pool to hundreds changes production behavior radically right before Day of Wine. That needs its own regression run.
