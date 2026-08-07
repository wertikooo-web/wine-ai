import { ConversationOrchestrator, createDashboardDomAdapter } from './ConversationOrchestrator.mjs';

export const START_INTENTS = Object.freeze([
  { id: 'choose_wine', icon: '🍷' },
  { id: 'pair_food', icon: '🍽️' },
  { id: 'learn_wine', icon: '🔎' },
  { id: 'visit_winery', icon: '🏰' },
]);

const COPY = Object.freeze({
  ru: {
    title: 'С чего начнём?',
    choose_wine: ['Выбрать вино', 'Помоги мне выбрать вино. Сначала задай один короткий вопрос, чтобы понять, что мне нужно.'],
    pair_food: ['К еде', 'Хочу подобрать вино к еде. Сначала спроси, что я буду есть.'],
    learn_wine: ['Узнать о вине', 'Хочу узнать больше о вине. Спроси, какое вино, сорт или регион меня интересует.'],
    visit_winery: ['Винодельни', 'Хочу узнать о винодельнях Молдовы или выбрать поездку. Спроси, что мне интереснее.'],
  },
  ro: {
    title: 'Cu ce începem?',
    choose_wine: ['Alege un vin', 'Ajută-mă să aleg un vin. Pune-mi mai întâi o întrebare scurtă ca să înțelegi ce caut.'],
    pair_food: ['Pentru mâncare', 'Vreau să aleg un vin pentru mâncare. Întreabă-mă mai întâi ce voi mânca.'],
    learn_wine: ['Despre vin', 'Vreau să aflu mai multe despre vin. Întreabă-mă ce vin, soi sau regiune mă interesează.'],
    visit_winery: ['Crama', 'Vreau să aflu despre cramele din Moldova sau să aleg o excursie. Întreabă-mă ce mă interesează mai mult.'],
  },
  en: {
    title: 'Where shall we start?',
    choose_wine: ['Choose a wine', 'Help me choose a wine. First ask one short question to understand what I need.'],
    pair_food: ['With food', 'I want to pair wine with food. First ask what I am going to eat.'],
    learn_wine: ['Learn about wine', 'I want to learn more about wine. Ask which wine, grape or region I am interested in.'],
    visit_winery: ['Wineries', 'I want to learn about Moldovan wineries or plan a visit. Ask which direction interests me more.'],
  },
  fr: {
    title: 'Par où commencer ?',
    choose_wine: ['Choisir un vin', 'Aide-moi à choisir un vin. Pose d’abord une courte question pour comprendre ce que je cherche.'],
    pair_food: ['Avec un plat', 'Je veux choisir un vin pour un plat. Demande-moi d’abord ce que je vais manger.'],
    learn_wine: ['Découvrir un vin', 'Je veux en savoir plus sur le vin. Demande quel vin, cépage ou région m’intéresse.'],
    visit_winery: ['Domaines', 'Je veux découvrir les domaines moldaves ou préparer une visite. Demande ce qui m’intéresse le plus.'],
  },
  it: {
    title: 'Da dove iniziamo?',
    choose_wine: ['Scegli un vino', 'Aiutami a scegliere un vino. Fammi prima una breve domanda per capire cosa cerco.'],
    pair_food: ['Con il cibo', 'Voglio abbinare un vino al cibo. Chiedimi prima cosa mangerò.'],
    learn_wine: ['Scopri il vino', 'Voglio saperne di più sul vino. Chiedimi quale vino, vitigno o regione mi interessa.'],
    visit_winery: ['Cantine', 'Voglio conoscere le cantine moldave o organizzare una visita. Chiedimi cosa mi interessa di più.'],
  },
  es: {
    title: '¿Por dónde empezamos?',
    choose_wine: ['Elegir un vino', 'Ayúdame a elegir un vino. Primero hazme una pregunta breve para entender qué busco.'],
    pair_food: ['Con comida', 'Quiero maridar vino con comida. Primero pregúntame qué voy a comer.'],
    learn_wine: ['Conocer un vino', 'Quiero saber más sobre vino. Pregúntame qué vino, uva o región me interesa.'],
    visit_winery: ['Bodegas', 'Quiero conocer bodegas de Moldavia o planear una visita. Pregúntame qué me interesa más.'],
  },
  de: {
    title: 'Womit beginnen wir?',
    choose_wine: ['Wein auswählen', 'Hilf mir, einen Wein auszuwählen. Stelle zuerst eine kurze Frage, um zu verstehen, was ich suche.'],
    pair_food: ['Zum Essen', 'Ich möchte Wein zum Essen auswählen. Frage mich zuerst, was ich essen werde.'],
    learn_wine: ['Wein entdecken', 'Ich möchte mehr über Wein erfahren. Frage mich, welcher Wein, welche Rebsorte oder Region mich interessiert.'],
    visit_winery: ['Weingüter', 'Ich möchte moldauische Weingüter kennenlernen oder einen Besuch planen. Frage mich, was mich mehr interessiert.'],
  },
  zh: {
    title: '从哪里开始？',
    choose_wine: ['选一款酒', '帮我选一款葡萄酒。先问我一个简短的问题，了解我的需求。'],
    pair_food: ['配餐', '我想选一款配餐葡萄酒。先问我准备吃什么。'],
    learn_wine: ['了解葡萄酒', '我想进一步了解葡萄酒。问我对哪款酒、葡萄品种或产区感兴趣。'],
    visit_winery: ['酒庄', '我想了解摩尔多瓦酒庄或安排参观。问我更感兴趣的是哪一种。'],
  },
  ja: {
    title: 'どこから始めますか？',
    choose_wine: ['ワインを選ぶ', 'ワイン選びを手伝ってください。まず、希望を知るための短い質問を一つしてください。'],
    pair_food: ['料理に合わせる', '料理に合うワインを選びたいです。まず何を食べるか聞いてください。'],
    learn_wine: ['ワインを知る', 'ワインについてもっと知りたいです。どのワイン、品種、産地に興味があるか聞いてください。'],
    visit_winery: ['ワイナリー', 'モルドバのワイナリーについて知るか、訪問を計画したいです。どちらに興味があるか聞いてください。'],
  },
});

export function normalizeStartIntentLanguage(language) {
  const value = String(language || '').toLowerCase();
  return COPY[value] ? value : 'en';
}

export function getStartIntentCopy(intentId, language) {
  const lang = normalizeStartIntentLanguage(language);
  const row = COPY[lang][intentId];
  if (!row) return null;
  return { id: intentId, label: row[0], starter: row[1], title: COPY[lang].title, language: lang };
}

export function detectVoiceMode(document) {
  return document?.getElementById('voiceModeTapBtn')?.classList?.contains('active')
    ? 'tap_to_start'
    : 'hold_to_talk';
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
    onStateChange(state) {
      root.dataset.conversationState = state;
    },
  });

  function render() {
    const lang = currentUiLanguage(document);
    title.textContent = COPY[normalizeStartIntentLanguage(lang)].title;
    grid.innerHTML = '';
    for (const intent of START_INTENTS) {
      const copy = getStartIntentCopy(intent.id, lang);
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
  }

  async function start(intentId) {
    const copy = getStartIntentCopy(intentId, currentUiLanguage(document));
    if (!copy) return;
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
  render();
  return { root, start, orchestrator, getSelectedIntent: () => selectedIntent };
}
