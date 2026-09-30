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

  // Cards stack vertically in the chat: at most two wines (+ one winery) per answer.
  const MAX_CARDS_PER_TURN = 2;
  const BLOCKED_HOSTS = /(^|\.)(example\.(com|org|net)|localhost|test|invalid|local)$/i;
  const CTA_LABELS = {
    BUY_OR_VIEW_ON_WINEMD: { ru: 'Посмотреть в WineMD', ro: 'Vezi pe WineMD', en: 'View on WineMD' },
    VISIT_WINERY_SITE: { ru: 'Сайт винодельни', ro: 'Site-ul cramei', en: 'Winery website' },
    OPEN_MAP: { ru: 'Открыть карту', ro: 'Deschide harta', en: 'Open map' },
    VIEW_WINE: { ru: 'Подробнее о вине', ro: 'Detalii vin', en: 'Wine details' },
    BOOK_TOUR: { ru: 'Забронировать экскурсию', ro: 'Rezervă excursia', en: 'Book a tour' },
    WINERY_ON_WINEMD: { ru: 'Вина на WineMD', ro: 'Vinuri pe WineMD', en: 'Wines on WineMD' },
  };
  const MAX_WINERY_CARDS_PER_TURN = 1;
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

  // Wineries named in the text (/api/companion/wineries entries). Russian
  // names are inflected ("в Криковы"): a Cyrillic name also matches its stem
  // plus up to three letters -- same rule as src/companion/wineryLinks.js.
  function wineryNameMatches(haystack, name) {
    if (haystack.includes(` ${name} `)) return true;
    const words = name.split(' ');
    const last = words[words.length - 1];
    if (!/^[а-я]+$/.test(last) || last.length < 5) return false;
    const stem = last.replace(/[аяоеиыуюьй]$/, '');
    return new RegExp(` ${[...words.slice(0, -1), stem].join(' ')}[а-я]{0,3} `).test(haystack);
  }
  function findWineries(text, wineries, max = MAX_WINERY_CARDS_PER_TURN) {
    const haystack = ` ${normalizeName(text).replace(/ё/g, 'е')} `;
    const found = [];
    for (const w of Array.isArray(wineries) ? wineries : []) {
      const names = Array.isArray(w && w.names) ? w.names : [];
      if (w && w.wineryId && names.some((n) => n && wineryNameMatches(haystack, n))) found.push(w);
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
    const price = card.price && card.currency ? `${card.price} ${card.currency}` : null;
    const meta = [card.type, card.sweetness, card.alcohol ? `${card.alcohol}%` : null, price].filter(Boolean).join(' · ');
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

  // Winery card: name + verified buttons (excursion booking with its
  // "N tours, from X MDL" line, the winery's wine.md page, official site).
  function buildWineryCard(doc, winery, { lang = 'ru', onCtaClick = () => {} } = {}) {
    const el = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    };
    const ctas = (Array.isArray(winery.ctas) ? winery.ctas : [])
      .map((cta) => ({ type: cta && cta.type, url: safeHttpsUrl(cta && cta.url), info: cta && typeof cta.info === 'string' ? cta.info.slice(0, 80) : null }))
      .filter((cta) => cta.url && CTA_LABELS[cta.type]);
    if (!ctas.length) return null;
    const root = el('div', 'wc-card wc-card--winery');
    root.dataset.wineryId = winery.wineryId;
    const body = el('div', 'wc-card__body');
    body.appendChild(el('div', 'wc-card__winery', lang === 'en' ? 'Winery' : (lang === 'ro' ? 'Cramă' : 'Винодельня')));
    body.appendChild(el('div', 'wc-card__name', winery.name));
    const tour = ctas.find((c) => c.type === 'BOOK_TOUR' && c.info);
    if (tour && lang === 'ru') body.appendChild(el('div', 'wc-card__meta', tour.info));
    const row = el('div', 'wc-card__ctas');
    for (const cta of ctas) {
      const a = el('a', 'wc-card__cta', label(CTA_LABELS, cta.type, lang));
      a.href = cta.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.addEventListener('click', () => { try { onCtaClick(winery, cta); } catch { /* analytics only */ } });
      row.appendChild(a);
    }
    body.appendChild(row);
    root.appendChild(body);
    return root;
  }

  // Controller used by the Lite page.
  function createCompanion({ doc, fetchImpl, getLang = () => 'ru', telemetry = () => {} }) {
    let catalog = null;
    let catalogPromise = null;
    let currentKey = null;
    const shownByKey = new Map();
    let wineries = null;
    let wineriesPromise = null;
    const shownWineriesByKey = new Map();

    function loadWineries() {
      if (wineries) return Promise.resolve(wineries);
      if (!wineriesPromise) {
        wineriesPromise = fetchImpl('/api/companion/wineries')
          .then((r) => r.json())
          .then((data) => { wineries = (data && data.enabled && Array.isArray(data.wineries)) ? data.wineries : []; return wineries; })
          .catch(() => { wineriesPromise = null; return []; });
      }
      return wineriesPromise;
    }

    // link_rendered / link_clicked for the operator's link analytics.
    function linkEvent(events) {
      try {
        fetchImpl('/api/analytics/link-event', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events }) }).catch(() => {});
      } catch { /* analytics only */ }
    }

    function railFor(anchor) {
      let rail = anchor && anchor.nextSibling && anchor.nextSibling.classList && anchor.nextSibling.classList.contains('wc-rail') ? anchor.nextSibling : null;
      if (!rail && anchor && anchor.parentNode) {
        rail = doc.createElement('div');
        rail.className = 'wc-rail';
        anchor.parentNode.insertBefore(rail, anchor.nextSibling);
      }
      return rail;
    }

    async function showWineries(key, text, anchor) {
      const list = await loadWineries();
      if (!list.length || key !== currentKey) return;
      const shown = shownWineriesByKey.get(key) || new Set();
      shownWineriesByKey.set(key, shown);
      if (shown.size >= MAX_WINERY_CARDS_PER_TURN) return;
      for (const winery of findWineries(text, list).filter((w) => !shown.has(w.wineryId))) {
        shown.add(winery.wineryId);
        const lang = getLang();
        const card = buildWineryCard(doc, winery, {
          lang,
          onCtaClick: (w, cta) => {
            telemetry('companion_link_clicked', { wineryId: w.wineryId, ctaType: cta.type, turnKey: key });
            linkEvent([{ event: 'link_clicked', entityType: 'winery', entityId: w.wineryId, entityName: w.name, ctaType: cta.type }]);
          },
        });
        const rail = card && railFor(anchor);
        if (!rail) continue;
        rail.appendChild(card);
        telemetry('companion_winery_card_shown', { wineryId: winery.wineryId, turnKey: key });
        linkEvent(winery.ctas.map((cta) => ({ event: 'link_rendered', entityType: 'winery', entityId: winery.wineryId, entityName: winery.name, ctaType: cta.type })));
      }
    }

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
      shownWineriesByKey.clear();
      loadCatalog();
      loadWineries();
    }

    // Called with the full assistant text so far for a turn and the bubble
    // it belongs to. The newest turn is the only one allowed to add cards.
    async function onAssistantText(key, text, anchor) {
      try {
        currentKey = key;
        showWineries(key, text, anchor).catch(() => {});
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
              linkEvent([{ event: 'link_clicked', entityType: 'wine', entityId: card.wineId, entityName: card.wineName, ctaType: cta.type }]);
              try {
                fetchImpl('/api/analytics/purchase-click', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wineId: card.wineId, optionId: cta.type, source: 'lite_companion' }) }).catch(() => {});
              } catch { /* analytics only */ }
            },
          }));
          telemetry('companion_wine_card_shown', { wineId: data.card.wineId, turnKey: key, ctaTypes: (data.card.ctas || []).map((c) => c.type) });
          linkEvent((data.card.ctas || []).map((c) => ({ event: 'link_rendered', entityType: 'wine', entityId: data.card.wineId, entityName: data.card.wineName, ctaType: c.type })));
        }
      } catch { /* presentation only */ }
    }

    return { reset, onAssistantText, loadCatalog, loadWineries };
  }

  return { normalizeName, findWines, findWineries, safeHttpsUrl, buildCard, buildWineryCard, createCompanion, CTA_LABELS, MAX_CARDS_PER_TURN };
}));
