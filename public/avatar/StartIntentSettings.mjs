import {
  START_INTENTS,
  START_INTENT_LANGUAGES,
  getStartIntentConfig,
  saveStartIntentConfig,
  resetStartIntentConfig,
} from './StartIntentLauncher.mjs';

const LANGUAGE_NAMES = Object.freeze({
  ru: 'Русский', ro: 'Română', en: 'English', fr: 'Français', it: 'Italiano',
  es: 'Español', de: 'Deutsch', zh: '中文', ja: '日本語',
});

function injectStyles(document) {
  if (document.getElementById('wineAiStartIntentSettingsStyles')) return;
  const style = document.createElement('style');
  style.id = 'wineAiStartIntentSettingsStyles';
  style.textContent = `
    .intent-settings{margin-top:18px;padding-top:18px;border-top:1px solid var(--border)}
    .intent-settings__head{display:flex;align-items:end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}
    .intent-settings__title{font-size:14px;font-weight:750;color:var(--wine)}
    .intent-settings__sub{font-size:12px;color:var(--muted);max-width:720px;margin-top:4px;line-height:1.45}
    .intent-settings__lang{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--muted)}
    .intent-settings__lang select{padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:#fff;color:var(--ink)}
    .intent-settings__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    @media(max-width:900px){.intent-settings__grid{grid-template-columns:1fr}}
    .intent-settings__card{border:1px solid var(--border);border-radius:12px;background:#fbf8f3;padding:12px}
    .intent-settings__cardhead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
    .intent-settings__name{font-weight:750;font-size:13px}
    .intent-settings__enabled{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted)}
    .intent-settings__field{display:flex;flex-direction:column;gap:5px;margin-top:9px}
    .intent-settings__field label{font-size:11px;font-weight:700;color:var(--muted)}
    .intent-settings__field input,.intent-settings__field textarea{width:100%;border:1px solid var(--border);border-radius:8px;padding:9px 10px;font:inherit;font-size:12px;background:#fff;color:var(--ink)}
    .intent-settings__field textarea{min-height:74px;resize:vertical;line-height:1.4}
    .intent-settings__actions{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
    .intent-settings__actions button{border:1px solid var(--border);border-radius:8px;padding:7px 10px;background:#fff;color:var(--ink);font:inherit;font-size:11px;font-weight:700;cursor:pointer}
    .intent-settings__actions button.primary{background:var(--wine);border-color:var(--wine);color:#fff}
    .intent-settings__status{font-size:11px;color:var(--muted)}
  `;
  document.head.appendChild(style);
}

export function mountStartIntentSettings(options = {}) {
  const document = options.document || globalThis.document;
  const storage = options.storage || globalThis.localStorage;
  if (!document || document.getElementById('startIntentSettings')) return null;
  const panel = document.getElementById('tab-settings');
  if (!panel) return null;

  injectStyles(document);

  const root = document.createElement('div');
  root.id = 'startIntentSettings';
  root.className = 'card intent-settings';
  root.innerHTML = `
    <div class="intent-settings__head">
      <div>
        <div class="intent-settings__title">Старт разговора: 4 быстрых сценария</div>
        <div class="intent-settings__sub">Здесь можно менять надпись на кнопке, точную первую реплику Wine AI, контекст дальнейшего разговора и временно отключать отдельные кнопки. Изменения применяются сразу после сохранения.</div>
      </div>
      <label class="intent-settings__lang">Язык кнопок
        <select id="startIntentSettingsLanguage"></select>
      </label>
    </div>
    <div class="intent-settings__grid" id="startIntentSettingsGrid"></div>
  `;
  panel.appendChild(root);

  const languageSelect = root.querySelector('#startIntentSettingsLanguage');
  const grid = root.querySelector('#startIntentSettingsGrid');
  START_INTENT_LANGUAGES.forEach((lang) => {
    const option = document.createElement('option');
    option.value = lang;
    option.textContent = LANGUAGE_NAMES[lang] || lang;
    languageSelect.appendChild(option);
  });
  const currentUiLanguage = document.getElementById('uiLangSelect')?.value;
  languageSelect.value = START_INTENT_LANGUAGES.includes(currentUiLanguage) ? currentUiLanguage : 'ru';

  function notifyChanged() {
    globalThis.dispatchEvent?.(new Event('wineai:start-intents-changed'));
  }

  function render() {
    const lang = languageSelect.value;
    grid.innerHTML = '';
    for (const intent of START_INTENTS) {
      const config = getStartIntentConfig(intent.id, lang, storage);
      const card = document.createElement('div');
      card.className = 'intent-settings__card';
      card.dataset.intentId = intent.id;
      card.innerHTML = `
        <div class="intent-settings__cardhead">
          <div class="intent-settings__name">${intent.icon} ${config.label}</div>
          <label class="intent-settings__enabled"><input type="checkbox" data-field="enabled" ${config.enabled ? 'checked' : ''}> Показывать кнопку</label>
        </div>
        <div class="intent-settings__field"><label>Надпись на кнопке</label><input data-field="label" maxlength="80"></div>
        <div class="intent-settings__field"><label>Первая реплика Wine AI</label><input data-field="openingLine" maxlength="500"></div>
        <div class="intent-settings__field"><label>Контекст после первого вопроса</label><textarea data-field="context" maxlength="3000"></textarea></div>
        <div class="intent-settings__actions">
          <button type="button" class="primary" data-action="save">Сохранить</button>
          <button type="button" data-action="reset">Вернуть по умолчанию</button>
          <span class="intent-settings__status" data-role="status"></span>
        </div>
      `;
      card.querySelector('[data-field="label"]').value = config.label;
      card.querySelector('[data-field="openingLine"]').value = config.openingLine;
      card.querySelector('[data-field="context"]').value = config.context;
      grid.appendChild(card);
    }
  }

  grid.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const card = button.closest('[data-intent-id]');
    if (!card) return;
    const intentId = card.dataset.intentId;
    const lang = languageSelect.value;
    const status = card.querySelector('[data-role="status"]');

    if (button.dataset.action === 'reset') {
      resetStartIntentConfig(intentId, lang, storage);
      render();
      notifyChanged();
      return;
    }

    saveStartIntentConfig(intentId, lang, {
      enabled: card.querySelector('[data-field="enabled"]').checked,
      label: card.querySelector('[data-field="label"]').value,
      openingLine: card.querySelector('[data-field="openingLine"]').value,
      context: card.querySelector('[data-field="context"]').value,
    }, storage);
    status.textContent = 'Сохранено';
    setTimeout(() => { if (status.isConnected) status.textContent = ''; }, 1400);
    notifyChanged();
  });

  languageSelect.addEventListener('change', render);
  render();
  return { root, render };
}
