const PROTOCOL_VERSION = 1;
const VISUAL_TYPES = new Set([
  'visual.reset', 'visual.avatar.state', 'visual.wine.show', 'visual.wine.hide',
  'visual.aromas.show', 'visual.pairing.show', 'visual.region.show',
  'visual.card.show', 'visual.commerce.show', 'visual.timeline.complete',
  'visual.timeline.cancel',
]);

const VISUAL_COPY = Object.freeze({
  en: { idleKicker: 'LIVE VISUAL STORY', idleTitle: 'Ask the sommelier about pairings', idleExample: 'For example: “What pairs with duck?”', aromas: 'AROMAS', pairing: 'PAIRING', order: 'ORDER', priceNote: 'WineMD partner', ready: 'READY', listening: 'LISTENING', thinking: 'THINKING', speaking: 'SPEAKING', presenting_wine: 'PRESENTING', pointing: 'RECOMMENDING', confirming_order: 'ORDER' },
  ru: { idleKicker: 'ЖИВАЯ ВИННАЯ ИСТОРИЯ', idleTitle: 'Спросите сомелье о сочетании', idleExample: 'Например: «Что посоветуешь к утке?»', aromas: 'АРОМАТЫ', pairing: 'СОЧЕТАНИЕ', order: 'ЗАКАЗАТЬ', priceNote: 'цена WineMD', ready: 'ГОТОВ', listening: 'СЛУШАЮ', thinking: 'ДУМАЮ', speaking: 'ГОВОРЮ', presenting_wine: 'ПОКАЗЫВАЮ ВИНО', pointing: 'РЕКОМЕНДУЮ', confirming_order: 'ЗАКАЗ' },
  ro: { idleKicker: 'POVESTE VIZUALĂ LIVE', idleTitle: 'Întreabă somelierul despre asocieri', idleExample: 'De exemplu: „Ce se potrivește cu rața?”', aromas: 'AROME', pairing: 'ASOCIERE', order: 'COMANDĂ', priceNote: 'preț partener WineMD', ready: 'GATA', listening: 'ASCULT', thinking: 'MĂ GÂNDESC', speaking: 'VORBESC', presenting_wine: 'PREZINT VINUL', pointing: 'RECOMAND', confirming_order: 'COMANDĂ' },
  fr: { idleKicker: 'RÉCIT VISUEL EN DIRECT', idleTitle: 'Demandez un accord au sommelier', idleExample: 'Par exemple : « Quel vin avec le canard ? »', aromas: 'ARÔMES', pairing: 'ACCORDS', order: 'COMMANDER', priceNote: 'prix partenaire WineMD', ready: 'PRÊT', listening: 'J’ÉCOUTE', thinking: 'RÉFLEXION', speaking: 'JE PARLE', presenting_wine: 'PRÉSENTATION', pointing: 'RECOMMANDATION', confirming_order: 'COMMANDE' },
  it: { idleKicker: 'RACCONTO VISIVO LIVE', idleTitle: 'Chiedi al sommelier gli abbinamenti', idleExample: 'Per esempio: «Cosa abbino all’anatra?»', aromas: 'AROMI', pairing: 'ABBINAMENTI', order: 'ORDINA', priceNote: 'prezzo partner WineMD', ready: 'PRONTO', listening: 'ASCOLTO', thinking: 'RIFLETTO', speaking: 'PARLO', presenting_wine: 'PRESENTAZIONE', pointing: 'CONSIGLIO', confirming_order: 'ORDINE' },
  es: { idleKicker: 'HISTORIA VISUAL EN VIVO', idleTitle: 'Pregunta al sumiller por maridajes', idleExample: 'Por ejemplo: «¿Qué combina con pato?»', aromas: 'AROMAS', pairing: 'MARIDAJE', order: 'PEDIR', priceNote: 'precio asociado WineMD', ready: 'LISTO', listening: 'ESCUCHANDO', thinking: 'PENSANDO', speaking: 'HABLANDO', presenting_wine: 'PRESENTANDO', pointing: 'RECOMENDANDO', confirming_order: 'PEDIDO' },
  de: { idleKicker: 'LIVE VISUAL STORY', idleTitle: 'Fragen Sie den Sommelier nach Kombinationen', idleExample: 'Zum Beispiel: „Was passt zu Ente?“', aromas: 'AROMEN', pairing: 'SPEISEBEGLEITUNG', order: 'BESTELLEN', priceNote: 'WineMD-Partnerpreis', ready: 'BEREIT', listening: 'ICH HÖRE ZU', thinking: 'ICH ÜBERLEGE', speaking: 'ICH SPRECHE', presenting_wine: 'PRÄSENTATION', pointing: 'EMPFEHLUNG', confirming_order: 'BESTELLUNG' },
  zh: { idleKicker: '实时视觉故事', idleTitle: '向侍酒师询问餐酒搭配', idleExample: '例如：“鸭肉适合搭配什么酒？”', aromas: '香气', pairing: '餐酒搭配', order: '订购', priceNote: 'WineMD 合作方价格', ready: '准备就绪', listening: '正在聆听', thinking: '正在思考', speaking: '正在讲解', presenting_wine: '正在展示', pointing: '正在推荐', confirming_order: '订购' },
  ja: { idleKicker: 'ライブ・ビジュアルストーリー', idleTitle: 'ソムリエにペアリングを相談', idleExample: '例：「鴨料理には何が合う？」', aromas: '香り', pairing: 'ペアリング', order: '注文する', priceNote: 'WineMD 提携先価格', ready: '準備完了', listening: '聞いています', thinking: '考えています', speaking: '話しています', presenting_wine: 'ワインを紹介中', pointing: 'おすすめ', confirming_order: '注文' },
});

// raspberry/linden/peach/grape only have en+ru entries (added for the
// rosé/white demo cards) — other languages fall back to en via copy()'s
// `table[this.language]?.[id] || table.en[id]` lookup, same as any id
// missing from a given language table.
const AROMA_LABELS = Object.freeze({
  en: { blackberry: 'Blackberry', plum: 'Plum', oak: 'Oak', strawberry: 'Strawberry', rose: 'Rose', citrus: 'Citrus', acacia: 'Acacia', pear: 'Pear', raspberry: 'Raspberry', linden: 'Linden blossom', peach: 'White peach', grape: 'Grape' },
  ru: { blackberry: 'Ежевика', plum: 'Слива', oak: 'Дуб', strawberry: 'Клубника', rose: 'Роза', citrus: 'Цитрус', acacia: 'Акация', pear: 'Груша', raspberry: 'Малина', linden: 'Цветы липы', peach: 'Белый персик', grape: 'Виноград' },
  ro: { blackberry: 'Mure', plum: 'Prună', oak: 'Stejar', strawberry: 'Căpșună', rose: 'Trandafir', citrus: 'Citrice', acacia: 'Salcâm', pear: 'Pară' },
  fr: { blackberry: 'Mûre', plum: 'Prune', oak: 'Chêne', strawberry: 'Fraise', rose: 'Rose', citrus: 'Agrumes', acacia: 'Acacia', pear: 'Poire' },
  it: { blackberry: 'Mora', plum: 'Prugna', oak: 'Rovere', strawberry: 'Fragola', rose: 'Rosa', citrus: 'Agrumi', acacia: 'Acacia', pear: 'Pera' },
  es: { blackberry: 'Mora', plum: 'Ciruela', oak: 'Roble', strawberry: 'Fresa', rose: 'Rosa', citrus: 'Cítricos', acacia: 'Acacia', pear: 'Pera' },
  de: { blackberry: 'Brombeere', plum: 'Pflaume', oak: 'Eiche', strawberry: 'Erdbeere', rose: 'Rose', citrus: 'Zitrus', acacia: 'Akazie', pear: 'Birne' },
  zh: { blackberry: '黑莓', plum: '李子', oak: '橡木', strawberry: '草莓', rose: '玫瑰', citrus: '柑橘', acacia: '洋槐', pear: '梨' },
  ja: { blackberry: 'ブラックベリー', plum: 'プラム', oak: 'オーク', strawberry: 'イチゴ', rose: 'バラ', citrus: '柑橘', acacia: 'アカシア', pear: '洋梨' },
});

const PAIRING_LABELS = Object.freeze({
  en: { duck: 'Duck with berry sauce', cheese: 'Aged cheeses', salmon: 'Salmon and seafood', salad: 'Light salads', salmon_tuna: 'Salmon and tuna', cheese_salad_1: 'Light cheeses and salads', seafood_fish: 'Seafood and fish', cheese_salad_2: 'Light salads and soft cheeses' },
  ru: { duck: 'Утка с ягодным соусом', cheese: 'Выдержанные сыры', salmon: 'Лосось и морепродукты', salad: 'Лёгкие салаты', salmon_tuna: 'Лосось и тунец', cheese_salad_1: 'Лёгкие сыры и салаты', seafood_fish: 'Морепродукты и рыба', cheese_salad_2: 'Лёгкие салаты и мягкие сыры' },
  ro: { duck: 'Rață cu sos de fructe', cheese: 'Brânzeturi maturate', salmon: 'Somon și fructe de mare', salad: 'Salate ușoare' },
  fr: { duck: 'Canard, sauce aux baies', cheese: 'Fromages affinés', salmon: 'Saumon et fruits de mer', salad: 'Salades légères' },
  it: { duck: 'Anatra con salsa ai frutti', cheese: 'Formaggi stagionati', salmon: 'Salmone e frutti di mare', salad: 'Insalate leggere' },
  es: { duck: 'Pato con salsa de frutos', cheese: 'Quesos curados', salmon: 'Salmón y marisco', salad: 'Ensaladas ligeras' },
  de: { duck: 'Ente mit Beerensauce', cheese: 'Gereifter Käse', salmon: 'Lachs und Meeresfrüchte', salad: 'Leichte Salate' },
  zh: { duck: '鸭肉配莓果酱', cheese: '陈年奶酪', salmon: '三文鱼与海鲜', salad: '清爽沙拉' },
  ja: { duck: '鴨のベリーソース', cheese: '熟成チーズ', salmon: 'サーモンと魚介', salad: '軽いサラダ' },
});

const REGION_LABELS = Object.freeze({
  en: { codru: 'Codru, Moldova', 'stefan-voda': 'Ștefan Vodă, Moldova' },
  ru: { codru: 'Кодру, Молдова', 'stefan-voda': 'Штефан-Водэ, Молдова' },
  ro: { codru: 'Codru, Moldova', 'stefan-voda': 'Ștefan Vodă, Moldova' },
  fr: { codru: 'Codru, Moldavie', 'stefan-voda': 'Ștefan Vodă, Moldavie' },
  it: { codru: 'Codru, Moldavia', 'stefan-voda': 'Ștefan Vodă, Moldavia' },
  es: { codru: 'Codru, Moldavia', 'stefan-voda': 'Ștefan Vodă, Moldavia' },
  de: { codru: 'Codru, Moldau', 'stefan-voda': 'Ștefan Vodă, Moldau' },
  zh: { codru: '科德鲁，摩尔多瓦', 'stefan-voda': '斯特凡沃达，摩尔多瓦' },
  ja: { codru: 'コドル、モルドバ', 'stefan-voda': 'シュテファン・ヴォダ、モルドバ' },
});

const WINE_DESCRIPTIONS = Object.freeze({
  en: { 'demo-wine-001': 'Dry red wine with dark berry aromas and gentle spicy notes.', 'demo-wine-002': 'Fresh dry rosé with bright berry aromas and a clean, cool finish.', 'demo-wine-003': 'Aromatic dry white with floral, pear and citrus notes.' },
  ru: { 'demo-wine-001': 'Сухое красное вино с ароматами тёмных ягод и мягкими пряными оттенками.', 'demo-wine-002': 'Свежее сухое розе с ярким ягодным ароматом и чистым прохладным послевкусием.', 'demo-wine-003': 'Ароматное сухое белое вино с цветочными, грушевыми и цитрусовыми нотами.' },
  ro: { 'demo-wine-001': 'Vin roșu sec cu arome de fructe negre și note condimentate fine.', 'demo-wine-002': 'Rosé sec și proaspăt, cu arome de fructe și final răcoritor.', 'demo-wine-003': 'Vin alb sec și aromat, cu note florale, de pară și citrice.' },
  fr: { 'demo-wine-001': 'Vin rouge sec aux arômes de fruits noirs et aux notes épicées délicates.', 'demo-wine-002': 'Rosé sec et frais aux arômes de fruits rouges et à la finale nette.', 'demo-wine-003': 'Vin blanc sec aromatique aux notes florales, de poire et d’agrumes.' },
  it: { 'demo-wine-001': 'Rosso secco con aromi di frutti scuri e delicate note speziate.', 'demo-wine-002': 'Rosato secco e fresco, dai profumi di frutti rossi e finale pulito.', 'demo-wine-003': 'Bianco secco aromatico con note floreali, pera e agrumi.' },
  es: { 'demo-wine-001': 'Tinto seco con aromas de frutos negros y suaves notas especiadas.', 'demo-wine-002': 'Rosado seco y fresco, con aromas de frutos rojos y final limpio.', 'demo-wine-003': 'Blanco seco aromático con notas florales, de pera y cítricos.' },
  de: { 'demo-wine-001': 'Trockener Rotwein mit dunklen Beerenaromen und feinen Gewürznoten.', 'demo-wine-002': 'Frischer trockener Rosé mit Beerenaromen und klarem, kühlem Abgang.', 'demo-wine-003': 'Aromatischer trockener Weißwein mit Blüten-, Birnen- und Zitrusnoten.' },
  zh: { 'demo-wine-001': '干型红葡萄酒，带有深色浆果香气和柔和辛香。', 'demo-wine-002': '清新的干型桃红葡萄酒，带有明亮莓果香气和爽净余味。', 'demo-wine-003': '芳香型干白葡萄酒，带有花香、梨和柑橘气息。' },
  ja: { 'demo-wine-001': '黒系果実の香りと穏やかなスパイス感をもつ辛口赤ワイン。', 'demo-wine-002': '明るいベリー香と爽やかな余韻をもつフレッシュな辛口ロゼ。', 'demo-wine-003': '花、洋梨、柑橘の香りをもつアロマティックな辛口白ワイン。' },
});

function normalizeLanguage(language) {
  return Object.hasOwn(VISUAL_COPY, language) ? language : 'en';
}

export class VisualEventGate {
  constructor() {
    this.activeGenerationId = null;
    this.lastSequence = 0;
    this.cancelled = new Set();
  }

  accept(event) {
    if (!event || event.protocolVersion !== PROTOCOL_VERSION || !VISUAL_TYPES.has(event.type)) {
      return { accepted: false, reason: 'invalid_protocol' };
    }
    if (typeof event.generationId !== 'string' || !Number.isSafeInteger(event.sequence)) {
      return { accepted: false, reason: 'invalid_correlation' };
    }
    if (this.cancelled.has(event.generationId)) {
      return { accepted: false, reason: 'cancelled_generation' };
    }
    if (event.type === 'visual.reset' && event.sequence === 1) {
      this.activeGenerationId = event.generationId;
      this.lastSequence = 0;
    }
    if (event.generationId !== this.activeGenerationId) {
      return { accepted: false, reason: 'stale_generation' };
    }
    if (event.sequence <= this.lastSequence) {
      return { accepted: false, reason: 'duplicate_or_out_of_order' };
    }
    this.lastSequence = event.sequence;
    if (event.type === 'visual.timeline.cancel') this.cancelled.add(event.generationId);
    return { accepted: true, reason: 'accepted' };
  }
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''), window.location.origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function setText(node, value) {
  if (node) node.textContent = String(value ?? '');
}

export class VisualStoryController {
  constructor(root, options = {}) {
    if (!root) throw new TypeError('visual_story_root_required');
    this.root = root;
    this.log = options.log || (() => {});
    this.onAvatarState = options.onAvatarState || (() => {});
    this.gate = new VisualEventGate();
    this.preloaded = new Map();
    this.analyser = null;
    this.samples = null;
    this.mouthFrame = 0;
    this.avatarState = 'idle';
    this.language = normalizeLanguage(options.language);
    this.current = {
      aromas: [],
      pairings: [],
      region: null,
      card: null,
    };
    this.renderShell();
    this.applyLanguage();
    this.startMouthLoop();
  }

  renderShell() {
    this.root.innerHTML = `
      <div class="vs-ambient" aria-hidden="true"></div>
      <div class="vs-avatar-wrap">
        <div class="vs-avatar" data-state="idle">
          <img src="/visual-assets/avatar-woman-1.png" alt="Цифровой сомелье WineMD">
          <span class="vs-mouth" aria-hidden="true"></span>
          <span class="vs-avatar-state">ГОТОВ</span>
        </div>
      </div>
      <div class="vs-presentation" aria-live="polite">
        <div class="vs-idle">
          <span class="vs-kicker"></span>
          <strong class="vs-idle-title"></strong>
          <small class="vs-idle-example"></small>
        </div>
        <div class="vs-wine" hidden>
          <div class="vs-bottle-wrap"><img class="vs-bottle" alt=""><span class="vs-shine"></span></div>
          <div class="vs-wine-label"><small></small><strong></strong><span></span></div>
        </div>
        <div class="vs-aromas" hidden><span class="vs-section-label"></span><div class="vs-chip-list"></div></div>
        <div class="vs-pairing" hidden><span class="vs-section-label"></span><div class="vs-chip-list"></div></div>
        <div class="vs-region" hidden></div>
        <div class="vs-card" hidden></div>
        <div class="vs-commerce" hidden>
          <div class="vs-qr-row" hidden>
            <img class="vs-qr" alt="QR-код для заказа">
          </div>
          <div class="vs-commerce-actions">
            <div class="vs-price-block">
              <strong class="vs-price"></strong>
            </div>
            <a class="vs-order" target="_blank" rel="noopener noreferrer">
              <span class="vs-order-bag" aria-hidden="true"></span>
              <span class="vs-order-label"></span>
            </a>
          </div>
        </div>
      </div>`;
    this.nodes = {
      idle: this.root.querySelector('.vs-idle'),
      idleKicker: this.root.querySelector('.vs-idle .vs-kicker'),
      idleTitle: this.root.querySelector('.vs-idle-title'),
      idleExample: this.root.querySelector('.vs-idle-example'),
      avatar: this.root.querySelector('.vs-avatar'),
      avatarState: this.root.querySelector('.vs-avatar-state'),
      mouth: this.root.querySelector('.vs-mouth'),
      wine: this.root.querySelector('.vs-wine'),
      bottle: this.root.querySelector('.vs-bottle'),
      wineKicker: this.root.querySelector('.vs-wine-label small'),
      wineName: this.root.querySelector('.vs-wine-label strong'),
      wineVintage: this.root.querySelector('.vs-wine-label span'),
      aromas: this.root.querySelector('.vs-aromas'),
      aromaSectionLabel: this.root.querySelector('.vs-aromas .vs-section-label'),
      aromaList: this.root.querySelector('.vs-aromas .vs-chip-list'),
      pairing: this.root.querySelector('.vs-pairing'),
      pairingSectionLabel: this.root.querySelector('.vs-pairing .vs-section-label'),
      pairingList: this.root.querySelector('.vs-pairing .vs-chip-list'),
      region: this.root.querySelector('.vs-region'),
      card: this.root.querySelector('.vs-card'),
      commerce: this.root.querySelector('.vs-commerce'),
      price: this.root.querySelector('.vs-price'),
      order: this.root.querySelector('.vs-order'),
      orderLabel: this.root.querySelector('.vs-order-label'),
      qr: this.root.querySelector('.vs-qr'),
      qrRow: this.root.querySelector('.vs-qr-row'),
    };
  }

  copy(key) {
    return VISUAL_COPY[this.language]?.[key] || VISUAL_COPY.en[key] || '';
  }

  localLabel(mode, id, fallback) {
    const table = mode === 'aroma' ? AROMA_LABELS : PAIRING_LABELS;
    return table[this.language]?.[id] || table.en[id] || fallback || '';
  }

  setLanguage(language) {
    this.language = normalizeLanguage(language);
    this.applyLanguage();
  }

  applyLanguage() {
    if (!this.nodes) return;
    setText(this.nodes.idleKicker, this.copy('idleKicker'));
    setText(this.nodes.idleTitle, this.copy('idleTitle'));
    setText(this.nodes.idleExample, this.copy('idleExample'));
    setText(this.nodes.aromaSectionLabel, this.copy('aromas'));
    setText(this.nodes.pairingSectionLabel, this.copy('pairing'));
    setText(this.nodes.orderLabel, this.copy('order'));
    this.updateAvatarStateLabel();
    if (this.current.aromas.length) this.renderChips(this.nodes.aromaList, this.current.aromas, 'aroma');
    if (this.current.pairings.length) this.renderChips(this.nodes.pairingList, this.current.pairings, 'pairing');
    if (this.current.region) this.renderRegion(this.current.region);
    if (this.current.card) this.renderCard(this.current.card.wineId, this.current.card.card);
  }

  updateAvatarStateLabel() {
    const key = this.avatarState === 'idle' ? 'ready' : this.avatarState;
    setText(this.nodes?.avatarState, this.copy(key) || this.copy('ready'));
  }

  attachAnalyser(analyser) {
    this.analyser = analyser || null;
    this.samples = analyser ? new Float32Array(analyser.fftSize) : null;
  }

  startMouthLoop() {
    const tick = () => {
      let mouth = 0;
      if (this.analyser && this.samples && this.avatarState === 'speaking') {
        this.analyser.getFloatTimeDomainData(this.samples);
        let sum = 0;
        for (const value of this.samples) sum += value * value;
        mouth = Math.min(1, Math.sqrt(sum / this.samples.length) * 7);
      }
      if (this.nodes?.mouth) this.nodes.mouth.style.setProperty('--mouth-open', mouth.toFixed(3));
      this.mouthFrame = requestAnimationFrame(tick);
    };
    this.mouthFrame = requestAnimationFrame(tick);
  }

  diagnostic(stage, event, extra = {}) {
    this.log(stage, {
      generationId: event?.generationId,
      sequence: event?.sequence,
      eventType: event?.type,
      ...extra,
    });
  }

  preload(url) {
    const safeUrl = safeHttpUrl(url);
    if (!safeUrl || this.preloaded.has(safeUrl)) return;
    const image = new Image();
    image.src = safeUrl;
    this.preloaded.set(safeUrl, image);
    while (this.preloaded.size > 12) this.preloaded.delete(this.preloaded.keys().next().value);
  }

  reset() {
    for (const key of ['wine', 'aromas', 'pairing', 'region', 'card', 'commerce']) {
      this.nodes[key].hidden = true;
    }
    this.nodes.idle.hidden = false;
    this.nodes.bottle.removeAttribute('src');
    this.nodes.order.removeAttribute('href');
    this.nodes.qr.removeAttribute('src');
    this.nodes.qrRow.hidden = true;
    this.current.aromas = [];
    this.current.pairings = [];
    this.current.region = null;
    this.current.card = null;
    this.setAvatarState('idle');
  }

  setAvatarState(state) {
    this.avatarState = state === 'speaking' ? 'speaking' : state;
    this.nodes.avatar.dataset.state = state;
    this.updateAvatarStateLabel();
    const deviceState = state === 'listening' ? 'listening'
      : state === 'thinking' ? 'thinking'
        : ['speaking', 'enthusiastic', 'presenting_wine', 'pointing', 'confirming_order'].includes(state) ? 'speaking'
          : 'ready';
    this.onAvatarState(deviceState);
  }

  renderChips(container, items, mode) {
    container.replaceChildren();
    const sourceItems = Array.isArray(items) ? items : [];
    const limit = mode === 'aroma' ? 5 : 3;
    const visibleItems = sourceItems.slice(0, limit);
    container.dataset.count = String(visibleItems.length);
    if (mode === 'aroma' && visibleItems.length === 3) {
      for (let index = 1; index <= 3; index += 1) {
        const link = document.createElement('span');
        link.className = `vs-aroma-link vs-aroma-link--${index}`;
        link.setAttribute('aria-hidden', 'true');
        container.appendChild(link);
      }
    }
    visibleItems.forEach((item, index) => {
      const chip = document.createElement('span');
      chip.className = `vs-chip ${mode === 'aroma' ? 'vs-aroma-node' : 'vs-pairing-item'}`;
      chip.dataset.index = String(index + 1);
      const artwork = document.createElement('i');
      artwork.className = 'vs-asset-art';
      artwork.dataset.assetId = String(item.id || 'fallback');
      artwork.setAttribute('role', 'img');
      const localizedLabel = this.localLabel(mode, item.id, item.label);
      artwork.setAttribute('aria-label', localizedLabel);
      const label = document.createElement('b');
      label.textContent = localizedLabel;
      chip.append(artwork, label);
      container.appendChild(chip);
    });
    if (sourceItems.length > limit) {
      const more = document.createElement('span');
      more.className = 'vs-chip-more';
      more.textContent = `ещё +${sourceItems.length - limit}`;
      container.appendChild(more);
    }
  }

  renderRegion(region) {
    const label = REGION_LABELS[this.language]?.[region?.id]
      || REGION_LABELS.en[region?.id]
      || region?.label
      || '';
    setText(this.nodes.region, `⌖ ${label}`);
  }

  renderCard(wineId, card) {
    this.nodes.card.replaceChildren();
    const description = document.createElement('p');
    description.textContent = WINE_DESCRIPTIONS[this.language]?.[wineId]
      || WINE_DESCRIPTIONS.en[wineId]
      || String(card?.shortDescription || '');
    const facts = document.createElement('div');
    facts.className = 'vs-facts';
    const temperature = document.createElement('span');
    temperature.className = 'vs-fact';
    const temperatureIcon = document.createElement('i');
    temperatureIcon.className = 'vs-fact-icon vs-fact-icon--temperature';
    temperatureIcon.setAttribute('aria-hidden', 'true');
    const temperatureText = document.createElement('span');
    temperatureText.textContent = String(card?.servingTemperature || '').replace(/\s*°\s*C/iu, '°');
    temperature.append(temperatureIcon, temperatureText);
    const alcohol = document.createElement('span');
    alcohol.className = 'vs-fact';
    const alcoholIcon = document.createElement('i');
    alcoholIcon.className = 'vs-fact-icon vs-fact-icon--wine';
    alcoholIcon.setAttribute('aria-hidden', 'true');
    const alcoholText = document.createElement('span');
    alcoholText.textContent = String(card?.alcohol || '');
    alcohol.append(alcoholIcon, alcoholText);
    if (temperatureText.textContent) facts.appendChild(temperature);
    if (alcoholText.textContent) facts.appendChild(alcohol);
    this.nodes.card.append(description, facts);
  }

  handle(event) {
    const decision = this.gate.accept(event);
    if (!decision.accepted) {
      this.diagnostic('visual_event_skipped', event, { reason: decision.reason });
      return false;
    }
    try {
      this.renderEvent(event);
      this.diagnostic('visual_event_rendered', event);
      return true;
    } catch (error) {
      this.diagnostic('visual_event_skipped', event, { reason: 'render_error', message: error.message });
      return false;
    }
  }

  renderEvent(event) {
    switch (event.type) {
      case 'visual.reset':
      case 'visual.timeline.cancel':
        this.reset();
        return;
      case 'visual.avatar.state':
        this.setAvatarState(event.state);
        return;
      case 'visual.wine.hide':
        this.nodes.wine.hidden = true;
        return;
      case 'visual.wine.show': {
        this.nodes.idle.hidden = true;
        this.nodes.wine.hidden = false;
        setText(this.nodes.wineKicker, event.label?.winery);
        setText(this.nodes.wineName, event.label?.name);
        setText(this.nodes.wineVintage, event.label?.vintage);
        const bottleUrl = safeHttpUrl(event.asset?.bottleUrl);
        const fallbackUrl = safeHttpUrl(event.asset?.fallbackUrl);
        this.preload(bottleUrl);
        this.preload(fallbackUrl);
        this.nodes.bottle.onerror = () => {
          this.nodes.bottle.onerror = null;
          if (fallbackUrl) this.nodes.bottle.src = fallbackUrl;
          this.diagnostic('visual_asset_failed', event, { assetSetId: event.assetSetId });
        };
        this.nodes.bottle.src = bottleUrl || fallbackUrl;
        return;
      }
      case 'visual.aromas.show':
        this.nodes.aromas.hidden = false;
        this.current.aromas = Array.isArray(event.descriptors) ? event.descriptors : [];
        this.renderChips(this.nodes.aromaList, event.descriptors, 'aroma');
        return;
      case 'visual.pairing.show':
        this.nodes.pairing.hidden = false;
        this.current.pairings = Array.isArray(event.pairings) ? event.pairings : [];
        this.renderChips(this.nodes.pairingList, event.pairings, 'pairing');
        return;
      case 'visual.region.show':
        this.nodes.region.hidden = false;
        this.current.region = event.region || null;
        this.renderRegion(event.region);
        return;
      case 'visual.card.show': {
        this.nodes.card.hidden = false;
        const card = event.card || {};
        this.current.card = { wineId: event.wineId, card };
        this.renderCard(event.wineId, card);
        return;
      }
      case 'visual.commerce.show': {
        const orderUrl = safeHttpUrl(event.commerce?.orderUrl);
        const qrUrl = safeHttpUrl(event.commerce?.qrUrl);
        if (!orderUrl) return;
        this.nodes.commerce.hidden = false;
        setText(this.nodes.price, `${event.commerce.price} ${event.commerce.currency}`);
        this.nodes.order.href = orderUrl;
        this.nodes.order.onclick = () => {
          this.diagnostic('commerce_cta_opened', event, { productId: event.commerce.productId });
          fetch('/api/analytics/purchase-click', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ wineId: event.wineId, optionId: event.commerce.productId }),
          }).catch(() => {});
        };
        if (qrUrl) {
          this.nodes.qr.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(qrUrl)}`;
          this.nodes.qr.onerror = () => this.diagnostic('visual_asset_failed', event, { asset: 'qr' });
          this.nodes.qrRow.hidden = false;
        } else {
          this.nodes.qr.removeAttribute('src');
          this.nodes.qrRow.hidden = true;
        }
        return;
      }
      case 'visual.timeline.complete':
      default:
        return;
    }
  }
}
