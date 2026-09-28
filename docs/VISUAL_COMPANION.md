# Visual Companion (Wine AI Lite)

Presentation layer on `/lite`, next to the voice conversation. It never controls voice:
if any part of it fails, the conversation continues.

## What participants see
- **Transcript**: "Вы" / persona name bubbles from `transcript.user` / `transcript.model`,
  rendered with `textContent` only (no HTML, model text never becomes a link).
- **Text input**: typed questions go through the existing `input_text.submit` path
  (same session, context and persona as voice).
- **Wine cards**: when the assistant names a wine from the **verified catalog**, a card
  appears under that message (image, winery, name, vintage, type, grapes, short
  description, serving, pairings — only fields that exist) with approved buttons.

## Grounding and link safety
- Cards come only from `companion_wines` (imported partner data). The demo catalog
  (`src/visual/visualCatalog.js`, example.com) is never used on `/lite`.
- The model never supplies a URL. The client resolves a card **by wine id** from
  `/api/companion/wines/:id` and renders only registry CTAs:
  `BUY_OR_VIEW_ON_WINEMD` (productUrl), `VISIT_WINERY_SITE` (wineryUrl), `OPEN_MAP` (mapUrl).
  Labels are localized in the client; the model cannot set labels or actions.
- URLs are validated at import and again when served and rendered: `https:` only, no
  credentials, no IP/localhost/example/test hosts, optional allowlist
  `COMPANION_URL_HOSTS=winemd.md,*.winemd.md`. Links open with `noopener noreferrer`.
- The knowledge tool tells the model which catalog wines are on screen (`screen_cards`),
  so "показываю карточку и ссылку на экране" is said only when true. On `/lite` the model is
  told never to read or invent URLs.
- A card resolved after its turn was superseded is dropped; at most 3 cards per answer;
  the same wine is not repeated within an answer.

## Operator: importing WineMD wines
Dashboard → Live Test → "Каталог вин WineMD": paste a JSON array and press Import.
Rejected records are listed with the reason. Each wine can be hidden/shown.

```json
[{
  "externalId": "WineMD SKU",
  "wineryName": "…", "wineName": "…", "vintage": 2021,
  "type": "red", "sweetness": "dry", "grapes": ["Fetească Neagră"], "region": "Codru",
  "alcohol": 13.5, "servingTemperature": "16–18°C",
  "shortDescription": "…", "tastingNotes": "…", "foodPairings": ["steak"],
  "imageUrl": "https://…", "productUrl": "https://…", "wineryUrl": "https://…",
  "price": 350, "currency": "MDL", "aliases": ["short name people say"]
}]
```
Required: `wineryName`, `wineName`. Minimum useful card: plus `imageUrl`, `productUrl`.
Re-importing the same `externalId` updates the wine.

Endpoints: `GET /api/companion/catalog`, `GET /api/companion/wines/:id` (public);
`GET /api/companion/wines`, `POST /api/companion/wines/import`,
`POST /api/companion/wines/:id/published` (x-admin-token when `ADMIN_TOKEN` is set).

## Analytics
`companion_wine_card_shown` and `companion_link_clicked` go through the existing client
telemetry channel; link clicks also hit `/api/analytics/purchase-click`
(`source: lite_companion`, `optionId` = CTA type).

## Rollback
`VISUAL_COMPANION_ENABLED=false`: `/lite` becomes the voice-only page (no transcript, text
input or cards), `/api/companion/catalog` returns nothing.

## Known limitations
- Card detection matches the verified catalog names (and aliases) in the assistant's
  transcript; a wine the assistant describes without naming it gets no card. Add
  `aliases` for names people actually say.
- Tapping a card does not yet set screen context ("а с чем его пить?" relies on the
  conversation history, which already contains the wine).
- Production catalog is empty until WineMD data is imported: no cards are shown.
