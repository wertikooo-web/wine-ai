# WINE AI Multi-Widget Architecture

Status: architectural decision for WINE AI.

## Principle

WINE AI has one shared backend/engine and multiple independently branded/configured widgets. A new customer or site must not create a fork of the AI backend or duplicate Gemini/Grok/GPT, RAG, memory, link resolution, analytics, or wine knowledge logic.

```text
                         WINE AI BACKEND
          realtime providers / RAG / memory / links / analytics
                              |
          +-------------------+-------------------+
          |                   |                   |
     Demo Widget         WineMD Widget       Winery Widget
     GitHub Pages         WineMD site        customer site
```

## Separation of responsibilities

### Shared backend
Owns:
- Gemini/Grok/GPT realtime provider integration
- session and interruption lifecycle
- Wine RAG/knowledge and canonical entities
- memory/context
- intent handling
- verified link resolution
- analytics and link events
- security and provider configuration

### Widget layer
Owns only presentation/site-specific configuration:
- widget_id / tenant identity
- branding, logo, colors, typography
- avatar/presentation
- labels and locale
- which supported quick intents are shown and their order
- layout/size/placement
- dynamic result-card presentation

A widget must not own a private copy of wine knowledge, provider logic, RAG, memory, or business rules.

## Widget identity

Every session/event must carry a stable `widget_id` (or equivalent tenant/client identifier). Initial targets:
- `wine_ai_demo` — WINE AI demonstration site / GitHub Pages
- `winemd` — WineMD deployment
- future winery/customer IDs, e.g. `purcari`

Analytics must be segmentable by widget_id.

## Shared intent contract

Visible buttons may differ by widget, but they map to stable backend intents. Example canonical intents:
- `choose_wine`
- `find_winery`
- `plan_visit`
- `food_pairing`
- `find_tasting`
- future intents added through the shared contract

The label `Choose Wine` and a Romanian/Russian equivalent can therefore invoke the same canonical intent. Site-specific buttons must not be implemented as provider-specific prompts when a canonical intent exists.

## Demo widget target

The WINE AI demo site should use a richer standalone widget based on the approved visual direction: avatar/header, five quick-intent tiles, voice control, conversation/text area and dynamic result cards.

Initial quick intents:
1. Choose Wine -> `choose_wine`
2. Wineries -> `find_winery`
3. Visit Moldova -> `plan_visit`
4. Food Pairing -> `food_pairing`
5. Tastings -> `find_tasting`

The user must also be able to ignore these shortcuts and ask any supported question by voice/text.

Static educational tiles such as Regions/Grape Varieties/Winery Stories/Aromas/Culture may remain elsewhere as content/navigation, but should not masquerade as the primary conversational actions unless explicitly configured as intents.

## Dynamic result cards

The result area must be data-driven, not a permanently hard-coded Feteasca Neagra card. Depending on the answer it may render a wine, winery, location, tasting/visit or other supported entity/action.

Examples of actions:
- More details
- Official website
- Open on map
- Visit / tasting / booking
- Wine/product page
- Where to buy, when verified data exists

URLs must come from the shared verified Link Resolver/data layer. Widgets must never guess or construct entity URLs from model output.

## Voice versus screen

Voice gives a natural short response. URLs are rendered on screen as clickable actions and should not be read aloud character-by-character.

Both canonical voice modes remain backend/product capabilities: Hold-to-Talk and Free Conversation. A widget may choose which controls to expose, but must not create a third incompatible session mode.

## Analytics contract

All relevant events must include `widget_id` and session identity. At minimum support:
- intent_requested / equivalent quick-intent event
- link_requested
- link_resolved
- link_rendered
- link_clicked

This allows comparison of WineMD, demo site and future winery widgets without separate analytics implementations.

## Embedding/deployment

The WINE AI demo may remain hosted on GitHub Pages. Static hosting is only the presentation host; realtime/API/WebSocket work remains on the WINE AI backend.

WineMD and future customers may embed a differently configured widget while using the same backend.

Prefer a shared widget package/runtime plus configuration/theme over copying the entire widget source for every customer. Customer-specific code should be exceptional and isolated.

## Compatibility rules

Adding or changing a widget must not require changes to Gemini, Grok or GPT provider implementations. It must not fork RAG, knowledge, memory, links or analytics.

Existing WineMD widget behavior must remain stable while the demo widget is developed. Shared contracts may be extended additively with regression tests.

## Security

Do not expose provider API keys in static sites/widgets. Widget identity/configuration is not authorization by itself. Backend must validate allowed origins/configuration where appropriate. External URLs must use the shared safe/verified link mechanism.

## Definition of done for a new widget

A new widget is a presentation/configuration client of the shared WINE AI engine. It can start a session, invoke canonical intents, conduct normal voice/text conversation, render structured result cards/verified links, emit widget-scoped analytics, and be disabled/changed without altering other widgets or realtime providers.
