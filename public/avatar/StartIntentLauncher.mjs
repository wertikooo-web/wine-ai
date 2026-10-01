import { ConversationOrchestrator, createDashboardDomAdapter } from './ConversationOrchestrator.mjs';

export const START_INTENT_STORAGE_KEY = 'wineAi.startIntentSettings.v1';
// Order = order on screen. `lite: false` keeps an intent on the operator
// dashboard only; public /lite shows the five guest entry points.
export const START_INTENTS = Object.freeze([
  { id: 'choose_wine', icon: '🍷' },
  { id: 'find_winery', icon: '🏛️' },
  { id: 'pair_food', icon: '🍽️' },
  { id: 'visit_winery', icon: '🗺️' },
  { id: 'find_tasting', icon: '🥂' },
  { id: 'learn_wine', icon: '🔎', lite: false },
]);

export const START_INTENT_LANGUAGES = Object.freeze(['ru', 'ro', 'en', 'fr', 'it', 'es', 'de', 'zh', 'ja']);

const COPY = Object.freeze({
  ru: {
    title: 'С чего начнём?',
    choose_wine: { label: 'Подобрать вино', openingLine: 'Что ищем: красное, белое, розовое или игристое?', context: 'Помоги пользователю подобрать молдавское вино. После первого вопроса уточняй только действительно нужные параметры (повод, вкус, бюджет) и затем предложи подходящие варианты из базы знаний Wine AI.' },
    pair_food: { label: 'Вино к еде', openingLine: 'Что у вас будет на столе?', context: 'Помоги подобрать вино к блюду пользователя. Уточни блюдо, способ приготовления и важные вкусовые детали, если это нужно, и предложи конкретные вина.' },
    learn_wine: { label: 'Узнать о вине', openingLine: 'О каком вине, сорте или регионе хотите узнать?', context: 'Объясняй вино, сорт, регион или стиль простым живым языком и используй базу знаний Wine AI для конкретных фактов.' },
    visit_winery: { label: 'Куда поехать', openingLine: 'Сколько у вас времени: несколько часов, целый день или несколько дней?', context: 'Помоги спланировать винную поездку по Молдове: какие винодельни посетить, сколько на это нужно времени, как далеко от Кишинёва. Опирайся на базу знаний Wine AI и называй конкретные винодельни.' },
    find_winery: { label: 'Винодельни', openingLine: 'Могу подсказать винодельню по региону, стилю вина или расстоянию от Кишинёва. Что вам интереснее?', context: 'Помоги узнать о винодельнях Молдовы: история, регион, вина, чем знамениты. Называй конкретные винодельни и опирайся на базу знаний Wine AI. Ссылки на сайт, карту или соцсети показывай на экране, не зачитывай их.' },
    find_tasting: { label: 'Дегустации', openingLine: 'Где вам удобнее: дегустация в Кишинёве или поездка на винодельню?', context: 'Помоги найти дегустацию или экскурсию на винодельне в Молдове. Называй конкретные винодельни, где есть дегустации, и опирайся на базу знаний Wine AI. Бронирование и ссылки показывай на экране, не зачитывай адреса.' },
  },
  ro: {
    title: 'Cu ce începem?',
    choose_wine: { label: 'Alege vinul', openingLine: 'Ce căutăm: roșu, alb, rose sau spumant?', context: 'Ajută utilizatorul să aleagă un vin moldovenesc. Pune doar întrebările de clarificare cu adevărat necesare (ocazie, gust, buget) și apoi recomandă variante din baza de cunoștințe Wine AI.' },
    pair_food: { label: 'Vin pentru mâncare', openingLine: 'Ce aveți pe masă?', context: 'Ajută utilizatorul să asocieze vinul cu mâncarea, clarifică preparatul când este necesar și recomandă vinuri concrete.' },
    learn_wine: { label: 'Despre vin', openingLine: 'Despre ce vin, soi sau regiune vreți să aflați?', context: 'Explică vinurile, soiurile, regiunile și stilurile clar și folosește baza de cunoștințe Wine AI pentru fapte concrete.' },
    visit_winery: { label: 'Unde să mergi', openingLine: 'Cât timp aveți: câteva ore, o zi întreagă sau câteva zile?', context: 'Ajută utilizatorul să planifice o călătorie viticolă în Moldova: ce crame să viziteze, cât timp durează, cât de departe sunt de Chișinău. Folosește baza de cunoștințe Wine AI și numește crame concrete.' },
    find_winery: { label: 'Vinării', openingLine: 'Vă pot sugera o vinărie după regiune, stilul vinului sau distanța de Chișinău. Ce vă interesează mai mult?', context: 'Ajută utilizatorul să descopere vinăriile din Moldova: istorie, regiune, vinuri. Numește vinării concrete și folosește baza de cunoștințe Wine AI. Linkurile se afișează pe ecran, nu le citi cu voce.' },
    find_tasting: { label: 'Degustări', openingLine: 'Ce preferați: o degustare în Chișinău sau o excursie la o vinărie?', context: 'Ajută utilizatorul să găsească o degustare sau o excursie la o vinărie din Moldova. Numește vinării concrete cu degustări și folosește baza de cunoștințe Wine AI. Rezervarea și linkurile se afișează pe ecran.' },
  },
  en: {
    title: 'Where shall we start?',
    choose_wine: { label: 'Choose Wine', openingLine: 'What are you looking for: red, white, rosé or sparkling?', context: 'Help the user choose a Moldovan wine. Ask only the clarifying questions that are genuinely useful (occasion, taste, budget), then recommend options from the Wine AI knowledge base.' },
    pair_food: { label: 'Food Pairing', openingLine: 'What are you having?', context: 'Help the user pair wine with their dish. Clarify the dish, cooking method and important flavor details when useful, then recommend specific wines.' },
    learn_wine: { label: 'Learn about wine', openingLine: 'Which wine, grape or region would you like to learn about?', context: 'Explain wine, grapes, regions and styles in clear natural language and use the Wine AI knowledge base for specific facts.' },
    visit_winery: { label: 'Visit Wineries', openingLine: 'How much time do you have: a few hours, one day or several days?', context: 'Help the user plan a wine trip in Moldova: which wineries to visit, how long it takes, how far they are from Chișinău. Use the Wine AI knowledge base and name specific wineries.' },
    find_winery: { label: 'Wineries', openingLine: 'I can suggest a winery by region, wine style or distance from Chișinău. What interests you most?', context: 'Help the user explore Moldovan wineries: history, region, wines, what they are known for. Name specific wineries and use the Wine AI knowledge base. Links are shown on screen, never read them aloud.' },
    find_tasting: { label: 'Tastings', openingLine: 'Would you prefer a tasting in Chișinău or a trip to a winery?', context: 'Help the user find a tasting or winery tour in Moldova. Name specific wineries that offer tastings and use the Wine AI knowledge base. Booking and links are shown on screen, never read them aloud.' },
  },
  fr: {
    title: 'Par où commencer ?',
    choose_wine: { label: 'Choisir un vin', openingLine: 'Pour quelle occasion choisissons-nous le vin ?', context: 'Aide l’utilisateur à choisir un vin adapté et ne pose que les questions de clarification vraiment utiles.' },
    pair_food: { label: 'Avec un plat', openingLine: 'Qu’allez-vous manger ?', context: 'Aide l’utilisateur à accorder le vin avec son plat et précise le plat si nécessaire.' },
    learn_wine: { label: 'Découvrir un vin', openingLine: 'Quel vin, cépage ou région souhaitez-vous découvrir ?', context: 'Explique clairement les vins, cépages, régions et styles en utilisant la base de connaissances Wine AI pour les faits précis.' },
    visit_winery: { label: 'Où aller', openingLine: 'Combien de temps avez-vous : quelques heures, une journée ou plusieurs jours ?', context: 'Aide l’utilisateur à planifier une excursion viticole en Moldavie et nomme des domaines précis de la base Wine AI.' },
    find_winery: { label: 'Domaines', openingLine: 'Je peux suggérer un domaine selon la région, le style de vin ou la distance depuis Chișinău. Qu’est-ce qui vous intéresse ?', context: 'Aide l’utilisateur à découvrir les domaines moldaves et nomme des domaines précis de la base Wine AI. Les liens s’affichent à l’écran.' },
    find_tasting: { label: 'Dégustations', openingLine: 'Préférez-vous une dégustation à Chișinău ou une visite dans un domaine ?', context: 'Aide l’utilisateur à trouver une dégustation ou une visite de domaine en Moldavie, en nommant des domaines précis de la base Wine AI.' },
  },
  it: {
    title: 'Da dove iniziamo?',
    choose_wine: { label: 'Scegli un vino', openingLine: 'Per quale occasione scegliamo il vino?', context: 'Aiuta l’utente a scegliere un vino adatto e fai solo le domande di chiarimento davvero utili.' },
    pair_food: { label: 'Con il cibo', openingLine: 'Cosa mangerete?', context: 'Aiuta l’utente ad abbinare il vino al piatto e chiarisci il piatto quando serve.' },
    learn_wine: { label: 'Scopri il vino', openingLine: 'Quale vino, vitigno o regione volete conoscere?', context: 'Spiega vini, vitigni, regioni e stili con linguaggio chiaro e usa la base Wine AI per i fatti specifici.' },
    visit_winery: { label: 'Dove andare', openingLine: 'Quanto tempo avete: qualche ora, un giorno o più giorni?', context: 'Aiuta l’utente a pianificare un viaggio del vino in Moldavia e nomina cantine precise della base Wine AI.' },
    find_winery: { label: 'Cantine', openingLine: 'Posso suggerire una cantina per regione, stile di vino o distanza da Chișinău. Cosa vi interessa?', context: 'Aiuta l’utente a conoscere le cantine moldave e nomina cantine precise della base Wine AI. I link sono mostrati sullo schermo.' },
    find_tasting: { label: 'Degustazioni', openingLine: 'Preferite una degustazione a Chișinău o una visita in cantina?', context: 'Aiuta l’utente a trovare una degustazione o una visita in cantina in Moldavia, nominando cantine precise della base Wine AI.' },
  },
  es: {
    title: '¿Por dónde empezamos?',
    choose_wine: { label: 'Elegir un vino', openingLine: '¿Para qué ocasión elegimos el vino?', context: 'Ayuda al usuario a elegir un vino adecuado y haz solo las preguntas aclaratorias realmente útiles.' },
    pair_food: { label: 'Con comida', openingLine: '¿Qué va a comer?', context: 'Ayuda al usuario a maridar el vino con su plato y aclara el plato cuando sea necesario.' },
    learn_wine: { label: 'Conocer un vino', openingLine: '¿Sobre qué vino, uva o región quiere saber más?', context: 'Explica vinos, uvas, regiones y estilos con claridad y usa la base de Wine AI para datos concretos.' },
    visit_winery: { label: 'Adónde ir', openingLine: '¿Cuánto tiempo tiene: unas horas, un día o varios días?', context: 'Ayuda al usuario a planificar una ruta del vino en Moldavia y nombra bodegas concretas de la base Wine AI.' },
    find_winery: { label: 'Bodegas', openingLine: 'Puedo sugerir una bodega por región, estilo de vino o distancia desde Chișinău. ¿Qué le interesa más?', context: 'Ayuda al usuario a conocer bodegas de Moldavia y nombra bodegas concretas de la base Wine AI. Los enlaces se muestran en pantalla.' },
    find_tasting: { label: 'Catas', openingLine: '¿Prefiere una cata en Chișinău o una visita a una bodega?', context: 'Ayuda al usuario a encontrar una cata o visita a una bodega en Moldavia, nombrando bodegas concretas de la base Wine AI.' },
  },
  de: {
    title: 'Womit beginnen wir?',
    choose_wine: { label: 'Wein auswählen', openingLine: 'Für welchen Anlass wählen wir den Wein?', context: 'Hilf dem Nutzer, einen passenden Wein auszuwählen, und stelle nur wirklich nötige Rückfragen.' },
    pair_food: { label: 'Zum Essen', openingLine: 'Was werden Sie essen?', context: 'Hilf dem Nutzer bei der Weinbegleitung zum Gericht und kläre das Gericht bei Bedarf.' },
    learn_wine: { label: 'Wein entdecken', openingLine: 'Über welchen Wein, welche Rebsorte oder Region möchten Sie mehr erfahren?', context: 'Erkläre Wein, Rebsorten, Regionen und Stile klar und nutze die Wine-AI-Wissensbasis für konkrete Fakten.' },
    visit_winery: { label: 'Wohin fahren', openingLine: 'Wie viel Zeit haben Sie: ein paar Stunden, einen Tag oder mehrere Tage?', context: 'Hilf dem Nutzer, eine Weinreise in Moldau zu planen, und nenne konkrete Weingüter aus der Wine-AI-Wissensbasis.' },
    find_winery: { label: 'Weingüter', openingLine: 'Ich kann ein Weingut nach Region, Weinstil oder Entfernung von Chișinău vorschlagen. Was interessiert Sie?', context: 'Hilf dem Nutzer, moldauische Weingüter kennenzulernen, und nenne konkrete Weingüter aus der Wine-AI-Wissensbasis. Links werden auf dem Bildschirm gezeigt.' },
    find_tasting: { label: 'Verkostungen', openingLine: 'Lieber eine Verkostung in Chișinău oder ein Ausflug zu einem Weingut?', context: 'Hilf dem Nutzer, eine Verkostung oder Weingutsführung in Moldau zu finden, und nenne konkrete Weingüter aus der Wine-AI-Wissensbasis.' },
  },
  zh: {
    title: '从哪里开始？',
    choose_wine: { label: '选一款酒', openingLine: '这次选酒是为了什么场合？', context: '帮助用户选择合适的葡萄酒，只询问真正需要的补充信息，然后给出相关建议。' },
    pair_food: { label: '配餐', openingLine: '您准备吃什么？', context: '帮助用户为菜肴搭配葡萄酒，必要时确认菜品和烹饪方式。' },
    learn_wine: { label: '了解葡萄酒', openingLine: '您想了解哪款酒、葡萄品种或产区？', context: '用清晰自然的语言解释葡萄酒、品种、产区和风格，具体事实使用 Wine AI 知识库。' },
    visit_winery: { label: '去哪里', openingLine: '您有多少时间：几个小时、一天还是几天？', context: '帮助用户规划摩尔多瓦葡萄酒之旅，并说出 Wine AI 知识库中的具体酒庄。' },
    find_winery: { label: '酒庄', openingLine: '我可以按产区、酒款风格或距基希讷乌的距离推荐酒庄。您更关心哪一点？', context: '帮助用户了解摩尔多瓦酒庄，说出 Wine AI 知识库中的具体酒庄。链接显示在屏幕上。' },
    find_tasting: { label: '品鉴', openingLine: '您更想在基希讷乌品鉴，还是去酒庄参观？', context: '帮助用户在摩尔多瓦找到品鉴或酒庄参观，说出 Wine AI 知识库中提供品鉴的具体酒庄。' },
  },
  ja: {
    title: 'どこから始めますか？',
    choose_wine: { label: 'ワインを選ぶ', openingLine: 'どんな場面のためにワインを選びますか？', context: 'ユーザーに合うワイン選びを手伝い、本当に必要な確認質問だけをして候補を提案する。' },
    pair_food: { label: '料理に合わせる', openingLine: '何を召し上がる予定ですか？', context: '料理に合うワイン選びを手伝い、必要に応じて料理や調理法を確認する。' },
    learn_wine: { label: 'ワインを知る', openingLine: 'どのワイン、品種、産地について知りたいですか？', context: 'ワイン、品種、産地、スタイルを分かりやすく説明し、具体的な事実には Wine AI の知識ベースを使う。' },
    visit_winery: { label: 'どこへ行く', openingLine: '時間はどれくらいありますか：数時間、1日、それとも数日？', context: 'モルドバのワイン旅行の計画を手伝い、Wine AI の知識ベースにある具体的なワイナリーを挙げる。' },
    find_winery: { label: 'ワイナリー', openingLine: '地域、ワインのスタイル、キシナウからの距離でワイナリーをご提案できます。どれに興味がありますか？', context: 'モルドバのワイナリー紹介を手伝い、Wine AI の知識ベースにある具体的なワイナリーを挙げる。リンクは画面に表示する。' },
    find_tasting: { label: 'テイスティング', openingLine: 'キシナウでのテイスティングと、ワイナリーへの訪問のどちらがよいですか？', context: 'モルドバでのテイスティングやワイナリーツアー探しを手伝い、テイスティングのある具体的なワイナリーを挙げる。' },
  },
});

export function normalizeStartIntentLanguage(language) {
  const value = String(language || '').toLowerCase();
  return COPY[value] ? value : 'en';
}

export function readStartIntentSettings(storage = globalThis.localStorage) {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(START_INTENT_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writeStartIntentSettings(settings, storage = globalThis.localStorage) {
  if (!storage) return;
  storage.setItem(START_INTENT_STORAGE_KEY, JSON.stringify(settings || {}));
}

export function getStartIntentConfig(intentId, language, storage = globalThis.localStorage) {
  const lang = normalizeStartIntentLanguage(language);
  const base = COPY[lang][intentId];
  if (!base) return null;
  const saved = readStartIntentSettings(storage)?.[lang]?.[intentId] || {};
  return {
    id: intentId,
    language: lang,
    title: COPY[lang].title,
    label: typeof saved.label === 'string' && saved.label.trim() ? saved.label.trim().slice(0, 80) : base.label,
    openingLine: typeof saved.openingLine === 'string' && saved.openingLine.trim() ? saved.openingLine.trim().slice(0, 500) : base.openingLine,
    context: typeof saved.context === 'string' && saved.context.trim() ? saved.context.trim().slice(0, 3000) : base.context,
    enabled: saved.enabled !== false,
  };
}

export function saveStartIntentConfig(intentId, language, patch, storage = globalThis.localStorage) {
  const lang = normalizeStartIntentLanguage(language);
  if (!START_INTENTS.some((item) => item.id === intentId)) throw new Error('invalid_start_intent');
  const settings = readStartIntentSettings(storage);
  settings[lang] ||= {};
  const current = settings[lang][intentId] || {};
  settings[lang][intentId] = {
    ...current,
    ...(patch.label !== undefined ? { label: String(patch.label).trim().slice(0, 80) } : {}),
    ...(patch.openingLine !== undefined ? { openingLine: String(patch.openingLine).trim().slice(0, 500) } : {}),
    ...(patch.context !== undefined ? { context: String(patch.context).trim().slice(0, 3000) } : {}),
    ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}),
  };
  writeStartIntentSettings(settings, storage);
  return getStartIntentConfig(intentId, lang, storage);
}

export function resetStartIntentConfig(intentId, language, storage = globalThis.localStorage) {
  const lang = normalizeStartIntentLanguage(language);
  const settings = readStartIntentSettings(storage);
  if (settings[lang]) {
    delete settings[lang][intentId];
    if (Object.keys(settings[lang]).length === 0) delete settings[lang];
  }
  writeStartIntentSettings(settings, storage);
  return getStartIntentConfig(intentId, lang, storage);
}

export function buildStartIntentStarter(config) {
  return [
    'Conversation start context:',
    config.context,
    `Your first spoken reply must be exactly this sentence, in the same language: "${config.openingLine.replace(/"/g, '\\"')}"`,
    'Do not add a greeting, explanation, preface or second question before or after that opening sentence. Continue naturally after the user answers.',
  ].join('\n');
}

// Backward-compatible helper used by existing tests/callers.
export function getStartIntentCopy(intentId, language, storage = globalThis.localStorage) {
  const config = getStartIntentConfig(intentId, language, storage);
  if (!config) return null;
  return { ...config, starter: buildStartIntentStarter(config) };
}

export function detectVoiceMode(document) {
  return document?.getElementById('voiceModeTapBtn')?.classList?.contains('active') ? 'tap_to_start' : 'hold_to_talk';
}

export function isFreeConversationActive(document) {
  const timer = document?.getElementById('voiceSessionTimer');
  return Boolean(timer && timer.hidden === false);
}

function injectStyles(document) {
  if (document.getElementById('wineAiStartIntentStyles')) return;
  const style = document.createElement('style');
  style.id = 'wineAiStartIntentStyles';
  style.textContent = `
    .start-intents{width:100%;margin:10px 0 12px;padding:10px;border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,.72)}
    .start-intents__title{font-size:12px;font-weight:700;color:var(--muted);margin:0 0 8px;text-align:center}
    .start-intents__grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}
    .start-intents__grid>.start-intent-btn:last-child:nth-child(odd){grid-column:1/-1}
    .start-intent-btn{min-height:46px;border:1px solid var(--border);border-radius:11px;background:#fff;color:var(--ink);font:inherit;font-size:12px;font-weight:650;cursor:pointer;padding:8px 7px;display:flex;align-items:center;justify-content:center;gap:6px;line-height:1.15}
    .start-intent-btn:hover,.start-intent-btn:focus-visible{border-color:var(--wine);outline:none}
    .start-intent-btn.selected{border-color:var(--wine);box-shadow:0 0 0 1px var(--wine);color:var(--wine)}
    .start-intents.busy .start-intent-btn:not(.selected){opacity:.55}
  `;
  document.head.appendChild(style);
}

function currentUiLanguage(document) {
  return document.getElementById('uiLangSelect')?.value || document.documentElement.lang || 'en';
}

export function mountStartIntentLauncher(options = {}) {
  const document = options.document || globalThis.document;
  const storage = options.storage || globalThis.localStorage;
  const publicMode = options.publicMode === true;
  if (!document || document.getElementById('startIntentLauncher')) return null;
  const connect = document.getElementById('connectBtn');
  if (!connect || !connect.parentNode) return null;

  injectStyles(document);
  const root = document.createElement('div');
  root.id = 'startIntentLauncher';
  root.className = 'start-intents';
  root.setAttribute('aria-label', 'Conversation starters');
  const title = document.createElement('div');
  title.className = 'start-intents__title';
  const grid = document.createElement('div');
  grid.className = 'start-intents__grid';
  root.append(title, grid);
  connect.parentNode.insertBefore(root, connect);

  let selectedIntent = null;
  const adapter = options.adapter || createDashboardDomAdapter(document);
  const orchestrator = options.orchestrator || new ConversationOrchestrator(adapter, {
    onStateChange(state) { root.dataset.conversationState = state; },
  });

  function render() {
    const lang = currentUiLanguage(document);
    title.textContent = COPY[normalizeStartIntentLanguage(lang)].title;
    grid.innerHTML = '';
    for (const intent of START_INTENTS) {
      if (publicMode && intent.lite === false) continue;
      const copy = getStartIntentCopy(intent.id, lang, storage);
      if (!copy?.enabled) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'start-intent-btn';
      button.dataset.startIntent = intent.id;
      button.setAttribute('aria-pressed', selectedIntent === intent.id ? 'true' : 'false');
      if (selectedIntent === intent.id) button.classList.add('selected');
      button.textContent = `${intent.icon} ${copy.label}`;
      button.addEventListener('click', () => start(intent.id));
      grid.appendChild(button);
    }
    root.hidden = grid.children.length === 0;
  }

  async function start(intentId) {
    const copy = getStartIntentCopy(intentId, currentUiLanguage(document), storage);
    if (!copy?.enabled) return;
    selectedIntent = intentId;
    root.classList.add('busy');
    render();
    try {
      await orchestrator.start({ starter: copy.starter, mode: detectVoiceMode(document) });
    } catch (error) {
      console.warn('[WineAI] start intent failed:', error?.message || error);
    } finally {
      root.classList.remove('busy');
    }
  }

  document.getElementById('uiLangSelect')?.addEventListener('change', render);
  globalThis.addEventListener?.('wineai:start-intents-changed', render);
  render();
  return { root, start, orchestrator, render, getSelectedIntent: () => selectedIntent };
}
