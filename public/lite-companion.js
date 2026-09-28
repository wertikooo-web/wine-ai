// Visual Companion — wine cards for Wine AI Lite.
//
// Presentation only. It observes the assistant transcript (already on the
// page) and, when the assistant names a wine from the VERIFIED partner
// catalog (/api/companion/catalog), fetches that wine's card by id
// (/api/companion/wines/:id) and renders it under the assistant's message.
// - No URL ever comes from the model: CTAs are the backend's approved types
//   with backend URLs, re-validated here (https only).
// - Everything is built with createElement/textContent (no HTML strings).
// - A card resolved after its turn is no longer current is dropped.
// - Any failure is swallowed: the conversation never depends on this file.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WineCompanion = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_CARDS_PER_TURN = 3;
  const BLOCKED_HOSTS = /(^|\.)(example\.(com|org|net)|localhost|test|invalid|local)$/i;
  const CTA_LABELS = {
    BUY_OR_VIEW_ON_WINEMD: { ru: 'Посмотреть в WineMD', ro: 'Vezi pe WineMD', en: 'View on WineMD' },
    VISIT_WINERY_SITE: { ru: 'Сайт винодельни', ro: 'Site-ul cramei', en: 'Winery website' },
    OPEN_MAP: { ru: 'Открыть карту', ro: 'Deschide harta', en: 'Open map' },
    VIEW_WINE: { ru: 'Подробнее о вине', ro: 'Detalii vin', en: 'Wine details' },
  };
  const FIELD_LABELS = {
    grapes: { ru: 'Сорта', ro: 'Soiuri', en: 'Grapes' },
    region: { ru: 'Регион', ro: 'Regiune', en: 'Region' },
    servingTemperature: { ru: 'Подача', ro: 'Servire', en: 'Serve at' },
    foodPairings: { ru: 'К блюдам', ro: 'Asocieri', en: 'Pairs with' },
  };

  function normalizeName(text) {
    return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[şș]/g, 's').replace(/[ţț]/g, 't').replace(/[^a-z0-9а-яё]+/gi, ' ').replace(/\s+/g, ' ').trim();
  }

  // Catalog wines named in the text, in catalog order, at most `max`.
  function findWines(text, catalog, max = MAX_CARDS_PER_TURN) {
    const haystack = ` ${normalizeName(text)} `;
    const found = [];
    for (const entry of Array.isArray(catalog) ? catalog : []) {
      const names = Array.isArray(entry && entry.names) ? entry.names : [];
      if (entry && entry.wineId && names.some((n) => n && haystack.includes(` ${n} `))) found.push(entry.wineId);
      if (found.length >= max) break;
    }
    return found;
  }

  function safeHttpsUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 2000) return null;
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (!host.includes('.') || BLOCKED_HOSTS.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
    return url.toString();
  }

  function label(table, key, lang) {
    const row = table[key];
    return row ? (row[lang] || row.ru) : null;
  }

  // Builds a card element. Only fields that exist are shown.
  function buildCard(doc, card, { lang = 'ru', onCtaClick = () => {} } = {}) {
    const el = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    };
    const root = el('div', 'wc-card');
    root.dataset.wineId = card.wineId;
    const image = safeHttpsUrl(card.imageUrl);
    if (image) {
      const img = el('img', 'wc-card__img');
      img.alt = card.wineName || '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => { if (img.parentNode) img.parentNode.removeChild(img); };
      img.src = image;
      root.appendChild(img);
    }
    const body = el('div', 'wc-card__body');
    if (card.wineryName) body.appendChild(el('div', 'wc-card__winery', card.wineryName));
    body.appendChild(el('div', 'wc-card__name', [card.wineName, card.vintage].filter(Boolean).join(' ')));
    const meta = [card.type, card.sweetness, card.alcohol ? `${card.alcohol}%` : null].filter(Boolean).join(' · ');
    if (meta) body.appendChild(el('div', 'wc-card__meta', meta));
    if (card.shortDescription) body.appendChild(el('div', 'wc-card__desc', card.shortDescription));
    for (const key of ['grapes', 'region', 'servingTemperature', 'foodPairings']) {
      const value = Array.isArray(card[key]) ? card[key].join(', ') : card[key];
      if (value) body.appendChild(el('div', 'wc-card__row', `${label(FIELD_LABELS, key, lang)}: ${value}`));
    }
    const ctas = (Array.isArray(card.ctas) ? card.ctas : [])
      .map((cta) => ({ type: cta && cta.type, url: safeHttpsUrl(cta && cta.url) }))
      .filter((cta) => cta.url && CTA_LABELS[cta.type]);
    if (ctas.length) {
      const row = el('div', 'wc-card__ctas');
      for (const cta of ctas) {
        const a = el('a', 'wc-card__cta', label(CTA_LABELS, cta.type, lang));
        a.href = cta.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.addEventListener('click', () => { try { onCtaClick(card, cta); } catch { /* analytics only */ } });
        row.appendChild(a);
      }
      body.appendChild(row);
    }
    root.appendChild(body);
    return root;
  }

  // Controller used by the Lite page.
  function createCompanion({ doc, fetchImpl, getLang = () => 'ru', telemetry = () => {} }) {
    let catalog = null;
    let catalogPromise = null;
    let currentKey = null;
    const shownByKey = new Map();

    function loadCatalog() {
      if (catalog) return Promise.resolve(catalog);
      if (!catalogPromise) {
        catalogPromise = fetchImpl('/api/companion/catalog')
          .then((r) => r.json())
          .then((data) => { catalog = (data && data.enabled && Array.isArray(data.wines)) ? data.wines : []; return catalog; })
          .catch(() => { catalogPromise = null; return []; });
      }
      return catalogPromise;
    }

    function reset() {
      catalog = null;
      catalogPromise = null;
      currentKey = null;
      shownByKey.clear();
      loadCatalog();
    }

    // Called with the full assistant text so far for a turn and the bubble
    // it belongs to. The newest turn is the only one allowed to add cards.
    async function onAssistantText(key, text, anchor) {
      try {
        currentKey = key;
        const list = await loadCatalog();
        if (!list.length || key !== currentKey) return;
        const shown = shownByKey.get(key) || new Set();
        shownByKey.set(key, shown);
        const ids = findWines(text, list).filter((id) => !shown.has(id)).slice(0, MAX_CARDS_PER_TURN - shown.size);
        for (const id of ids) {
          shown.add(id);
          const response = await fetchImpl(`/api/companion/wines/${encodeURIComponent(id)}`);
          if (!response.ok) continue;
          const data = await response.json();
          if (key !== currentKey || !data || !data.card) continue; // stale turn: drop
          let rail = anchor && anchor.nextSibling && anchor.nextSibling.classList && anchor.nextSibling.classList.contains('wc-rail') ? anchor.nextSibling : null;
          if (!rail) {
            rail = doc.createElement('div');
            rail.className = 'wc-rail';
            if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(rail, anchor.nextSibling);
            else continue;
          }
          const lang = getLang();
          rail.appendChild(buildCard(doc, data.card, {
            lang,
            onCtaClick: (card, cta) => {
              telemetry('companion_link_clicked', { wineId: card.wineId, ctaType: cta.type, turnKey: key });
              try {
                fetchImpl('/api/analytics/purchase-click', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wineId: card.wineId, optionId: cta.type, source: 'lite_companion' }) }).catch(() => {});
              } catch { /* analytics only */ }
            },
          }));
          telemetry('companion_wine_card_shown', { wineId: data.card.wineId, turnKey: key, ctaTypes: (data.card.ctas || []).map((c) => c.type) });
        }
      } catch { /* presentation only */ }
    }

    return { reset, onAssistantText, loadCatalog };
  }

  return { normalizeName, findWines, safeHttpsUrl, buildCard, createCompanion, CTA_LABELS, MAX_CARDS_PER_TURN };
}));
