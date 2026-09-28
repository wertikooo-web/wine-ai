# WINE AI widget for the WineMD website

One Wine AI, one backend. The website widget and the QR code open the same page:
`/lite` (Wine AI Lite). The widget is only a launcher and a panel.

```
WineMD page → wine-ai-widget.js (launcher + panel) → /lite?embed=1 → wine-ai backend
QR code     → /lite (fullscreen on phones)                          → wine-ai backend
```

## Install (one line before `</body>`)

```html
<script src="https://wine-ai-realtime-production.up.railway.app/wine-ai-widget.js" async></script>
```

Optional attributes: `data-lang="ro|ru|en"` (whole widget UI: launcher, buttons, age gate,
rating; default = the WineMD page's `<html lang>`, otherwise **English**). The conversation
language itself stays AUTO (Maria answers in the language she is spoken to).
`data-position="right|left"`. JavaScript API: `WineAIWidget.open()`, `WineAIWidget.close()`.

- Launcher (Maria + "WINE AI · Спросить сомелье") and its styles live in a Shadow DOM:
  host CSS does not affect it, and it does not affect the host page. One fixed-position
  element is added to `<body>`; nothing else on the page is touched.
- The panel is an iframe (`allow="microphone; autoplay"`) created on first open.
  Desktop: 400×720 panel above the launcher. Phones (≤540px): fullscreen.
- Closing (× in the panel, clicking the launcher again, Esc) stops the conversation and
  releases the microphone. Messages are accepted only from the Wine AI origin / iframe.
- If the host site sends a Permissions-Policy or CSP, it must allow the microphone for
  the Wine AI origin and `frame-src`/`script-src` for it.

## Participant flow
"Поговорить с сомелье" → microphone permission → age confirmation (once) → Free
Conversation: Connecting → Listening → Thinking → Maria speaks → Listening, no button per
turn. Transcript, typed questions and verified wine cards (Visual Companion) are shown when
available; with an empty catalog the widget works by voice and text without cards.

## Age confirmation inside the widget
A cross-site iframe cannot rely on the `wine_ai_adult` cookie (SameSite=Lax is not sent;
Safari blocks third-party cookies). After confirmation the server also returns the same
signed value as a token; the page keeps it for the tab and sends it with the status check
(`x-adult-token`) and the realtime socket (`av=`). Without it, pairing/serving tools would
refuse (`age_verification_required`) on the partner site.

## URLs
- Widget script: `/wine-ai-widget.js`
- Standalone / QR: `/lite`
- Embedded page: `/lite?embed=1` (only styled as embedded inside an iframe)
