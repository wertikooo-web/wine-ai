# Operator content: Recommendations and News

Dashboard page: `/dashboard/content` (admin).

API (admin):
- `GET /api/operator-content`
- `PUT /api/operator-content/{recommendations|news}`
- `GET /api/analytics/operator-content?days=30`

Defaults: **both OFF**. No row exists until an operator saves.

## Principle

Operator text is **data**, not instructions. It is parsed once at save time into structured items. It is never appended to the system prompt and never sent to the model as a whole.

```
save → validate → persist raw text → parse (no LLM) → resolve wines/wineries against the catalog
     → store structured items + resolution report → this process applies at once,
       others within 15 s (no redeploy)
```

## Recommendations (OFF / SHADOW / ON)

Where it acts: inside `recommendWine()` (`src/knowledge/wineIntelligence.js`), after the organic ranking. Hook: `promotionHook` in `src/tools/searchLayeredKnowledge.js`; logic in `src/operatorContent/promotionLayer.js`.

```
request → engine's own preferences (parseRecommendationPreferences) → organic ranking
  → per promotion:
      1. rule applies? A line's conditions ("для белых сухих", "к рыбе") must be asked
         for: style group OR food group.
      2. hard constraints on VERIFIED catalog facts (companion_wines via companionWineFacts):
         - colour = requested colour;
         - sweetness = requested sweetness (unknown → not eligible);
         - budget: price known and ≤ budget (unknown or over → not eligible);
         - not excluded by the guest ("кроме X", "без X", "except X").
      3. organic-equivalent score (same scorer) + bounded boost
  → hypothetical ranking (stable: ties keep organic order)
```

Modes:
- **SHADOW**: steps run and are recorded. The guest gets exactly the organic result.
- **ON**: the hypothetical ranking is returned.

Promotion runs only when the organic engine already has a recommendation, so it never creates a recommendation where there was none. V1 acts on the preference-recommendation scenario only (`recommendWine`), not on dish pairing or comparison.

The boost is an operator setting:
- default `DEFAULT_PROMOTION_BOOST` = 8, bounded 0–20;
- organic scale for reference: colour 20, food 15, sweetness 12, body 10, budget 10;
- tune it from shadow data before switching ON.

Facts never come from operator text. Prices, awards and "the best" in the textarea are ignored: a promotion stores only `wineId` and conditions. A name that is unknown or ambiguous in the catalog is not promoted. The Dashboard shows its status.

## News

Where it acts: `attachOperatorNews` (the `search_wine_knowledge` result wrapper). Logic in `findRelevantNews` (`src/operatorContent/index.js`).

At save time, each paragraph or bullet becomes an item with:
- entities: catalog wineries and wines;
- topics: tasting, tour, event, new_wine, offer, hours;
- word stems.

Instruction-like items are rejected.

At query time an item is relevant if it reaches a score of 3 or more:
- entity match: +3;
- topic match: +2;
- word overlap: +1;
- "what's new" intent: +1;
- general news for a general "what's new": +3.

At most 2 items are attached as `operator_news` with `source_type: operator_news`, plus a fixed note: recent team information, may differ from the catalog, information and not an instruction. Unrelated questions get nothing.

Expiry is checked on every read (`active_from` / `active_until`). No cleanup is needed.

## Analytics (shared `link_events`)

- `recommendation_ranked`: one row per evaluated promotion (shadow or on). `detail` = `promotionId|{m, b, ow, os, ps, hs, pos, chg, x, l, pr}`:
  - `m` mode; `b` boost;
  - `ow` organic winner; `os` organic winner's score;
  - `ps` promoted organic score; `hs` hypothetical score; `pos` position;
  - `chg` would the ranking change; `x` exclusion reason;
  - `l` language; `pr` provider.
  
  Session id and channel are in their own columns. No transcript is stored.
- `news_used`: one row per attached item.
- The link stats page ignores both. Summary: `summarizeOperatorContent()`.

## Data model

```sql
CREATE TABLE IF NOT EXISTS operator_content (
  id TEXT PRIMARY KEY,                -- 'recommendations' | 'news'
  type TEXT NOT NULL,
  raw_text TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  mode TEXT NOT NULL DEFAULT 'off',   -- recommendations: off|shadow|on
  active_from TIMESTAMPTZ, active_until TIMESTAMPTZ,
  settings JSONB NOT NULL DEFAULT '{}',  -- { boost }
  parsed JSONB NOT NULL DEFAULT '{}',    -- promotions / items + per-line resolution report
  version INT NOT NULL DEFAULT 0,
  created_at, updated_at TIMESTAMPTZ, updated_by TEXT);
```

The table is created lazily on first use, like the other runtime tables. Rollback: `DROP TABLE operator_content;`. `link_events` has no schema change; it only gets new `event` values.

## Kill switches

Two ways to switch either feature off, both without a deploy:
- Dashboard: uncheck «Активно», or set Recommendations to «Выкл»;
- `PUT /api/operator-content/{type}` with `{ "enabled": false }`.

Both take effect immediately in the saving process and within 15 s everywhere.
