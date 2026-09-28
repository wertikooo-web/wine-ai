/*
 * WINE AI website widget (WineMD).
 *
 *   <script src="https://<wine-ai-host>/wine-ai-widget.js" async></script>
 *
 * Optional attributes on the script tag:
 *   data-lang="ro|ru|en"        interface language (default: the page's lang, else en)
 *   data-position="right|left"  corner (default: right)
 *
 * A floating launcher (Maria + "Спросить сомелье") opens the SAME Wine AI
 * Lite used by the QR code (/lite?embed=1) in an iframe panel. The widget is
 * only a shell: no conversation logic lives here. Isolation: launcher and
 * styles live in a Shadow DOM; the conversation runs in the iframe on the
 * Wine AI origin. Closing stops the conversation (mic released) and hides
 * the panel; the host page is never modified beyond one fixed-position host
 * element. Public API: window.WineAIWidget.open() / .close().
 */
(() => {
  'use strict';

  if (window.WineAIWidget) return;
  const script = document.currentScript;
  if (!script || !script.src) return;

  const origin = new URL(script.src, window.location.href).origin;
  const pageLang = String(document.documentElement.lang || '').slice(0, 2).toLowerCase();
  // Language: data-lang, else the WineMD page language (ro/ru/en), else English.
  const lang = ['ru', 'ro', 'en'].includes(script.dataset.lang) ? script.dataset.lang : (['ru', 'ro', 'en'].includes(pageLang) ? pageLang : 'en');
  const side = script.dataset.position === 'left' ? 'left' : 'right';
  const TEXT = {
    ru: { cta: 'Спросить сомелье', open: 'Открыть WINE AI — сомелье', close: 'Закрыть WINE AI' },
    ro: { cta: 'Întreabă somelierul', open: 'Deschide WINE AI — somelier', close: 'Închide WINE AI' },
    en: { cta: 'Ask the sommelier', open: 'Open WINE AI sommelier', close: 'Close WINE AI' },
  }[lang];

  const host = document.createElement('div');
  host.id = 'wine-ai-widget-host';
  host.style.cssText = `position:fixed;${side}:20px;bottom:20px;z-index:2147483000;`;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .launcher { all: unset; cursor: pointer; display: flex; align-items: center; gap: 10px; padding: 6px 16px 6px 6px; border-radius: 999px;
      background: linear-gradient(135deg, #4a1420, #6b1e2b); color: #fdf6ec; font: 600 14px/1.1 Inter, system-ui, -apple-system, 'Segoe UI', sans-serif;
      box-shadow: 0 16px 40px rgba(62,12,27,.34), inset 0 0 0 2px rgba(255,236,205,.25); transition: transform .18s ease, box-shadow .18s ease; }
    .launcher:hover { transform: translateY(-2px); box-shadow: 0 20px 46px rgba(62,12,27,.4); }
    .launcher:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }
    .avatar { width: 56px; height: 56px; border-radius: 50%; overflow: hidden; border: 3px solid #b97445; background: #f7f1e8; flex: none; }
    .avatar img { width: 100%; height: 100%; object-fit: cover; object-position: 50% 20%; display: block; }
    .label { display: flex; flex-direction: column; gap: 3px; }
    .label b { font-size: 12px; letter-spacing: .14em; }
    .label span { font-size: 14px; font-weight: 600; }
    .panel { position: absolute; ${side}: 0; bottom: 84px; width: min(400px, calc(100vw - 24px)); height: min(720px, calc(100vh - 110px));
      border: 0; border-radius: 22px; background: #fdfbf7; box-shadow: 0 24px 80px rgba(35,16,22,.3); display: none; }
    .panel.open { display: block; }
    @media (max-width: 540px) {
      .panel { position: fixed; inset: 0; width: 100vw; height: 100dvh; border-radius: 0; }
      .launcher.hidden { display: none; }
      .label span { font-size: 13px; }
    }
    @media (prefers-reduced-motion: reduce) { .launcher { transition: none; } }
  `;

  const launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'launcher';
  launcher.setAttribute('aria-label', TEXT.open);
  launcher.setAttribute('aria-expanded', 'false');
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  const img = document.createElement('img');
  img.src = `${origin}/visual-assets/avatar-woman-1.png`;
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  avatar.appendChild(img);
  const label = document.createElement('span');
  label.className = 'label';
  const brand = document.createElement('b');
  brand.textContent = 'WINE AI';
  const cta = document.createElement('span');
  cta.textContent = TEXT.cta;
  label.append(brand, cta);
  launcher.append(avatar, label);

  let iframe = null;
  let isOpen = false;

  function ensureIframe() {
    if (iframe) return iframe;
    iframe = document.createElement('iframe');
    iframe.className = 'panel';
    iframe.title = 'WINE AI';
    iframe.allow = 'microphone; autoplay';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.src = `${origin}/lite?embed=1&lang=${lang}`;
    shadow.insertBefore(iframe, launcher);
    return iframe;
  }

  function setOpen(open) {
    isOpen = open;
    if (open) ensureIframe().classList.add('open');
    else if (iframe) {
      // Stop the conversation first so the microphone is released.
      try { iframe.contentWindow.postMessage({ type: 'wine-ai:stop' }, origin); } catch { /* not loaded yet */ }
      iframe.classList.remove('open');
    }
    launcher.classList.toggle('hidden', open);
    launcher.setAttribute('aria-expanded', String(open));
    launcher.setAttribute('aria-label', open ? TEXT.close : TEXT.open);
  }

  launcher.addEventListener('click', () => setOpen(!isOpen));
  window.addEventListener('message', (event) => {
    if (event.origin !== origin || !iframe || event.source !== iframe.contentWindow) return;
    if (event.data && event.data.type === 'wine-ai:close') setOpen(false);
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && isOpen) setOpen(false); });

  shadow.append(style, launcher);
  (document.body || document.documentElement).appendChild(host);
  window.WineAIWidget = Object.freeze({ open: () => setOpen(true), close: () => setOpen(false) });
})();
