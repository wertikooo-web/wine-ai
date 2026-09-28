// Dashboard → Live Test (closed beta Test Control). Operator-only.
// Draft lives only in this page until "APPLY TO NEW SESSIONS"; presets and
// baseline load INTO the draft and never publish by themselves.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const FIELDS = ['provider', 'voice', 'persona', 'mood', 'responseLength', 'tone', 'expertiseLevel', 'conversationMode', 'knowledgeMode'];
  const SELECT_ID = {
    provider: 'ltProvider', voice: 'ltVoice', persona: 'ltPersona', mood: 'ltMood', responseLength: 'ltResponseLength',
    tone: 'ltTone', expertiseLevel: 'ltExpertiseLevel', conversationMode: 'ltConversationMode', knowledgeMode: 'ltKnowledgeMode',
  };
  const LABELS = {
    provider: 'Provider', voice: 'Voice', persona: 'Persona', mood: 'Mood', responseLength: 'Длина ответа', tone: 'Тон',
    expertiseLevel: 'Экспертность', conversationMode: 'Режим разговора', knowledgeMode: 'Знания',
  };
  const KNOWLEDGE_LABELS = { database_first: 'База + интернет, если в базе нет', database_only: 'Только база знаний' };
  let state = null;
  let draft = null;
  let loadedOnce = false;

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function adminHeaders() {
    let token = '';
    try { token = sessionStorage.getItem('wineAiAdminToken') || ''; } catch { /* storage unavailable */ }
    return token ? { 'x-admin-token': token } : {};
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...adminHeaders(), ...(options.headers || {}) } });
    if (response.status === 401) {
      const token = window.prompt('Admin token:');
      if (token) {
        try { sessionStorage.setItem('wineAiAdminToken', token); } catch { /* ignore */ }
        return api(path, options);
      }
    }
    const data = await response.json().catch(() => ({ ok: false, error: 'invalid_response' }));
    if (!response.ok || data.ok === false) {
      const details = Array.isArray(data.details) ? ': ' + data.details.join(', ') : '';
      throw new Error((data.error || `http_${response.status}`) + details);
    }
    return data;
  }

  function personaName(id) {
    const p = state?.options.personas.find((x) => x.id === id);
    return p ? p.name : id;
  }

  function describe(config) {
    if (!config) return '—';
    return [config.provider, personaName(config.persona), config.voice, config.mood, config.responseLength,
      config.knowledgeMode === 'database_only' ? 'database only' : 'database first'].map((x) => String(x).toUpperCase()).join(' · ');
  }

  function fillSelect(id, values, current, labelFn = (v) => v) {
    const el = $(id);
    el.innerHTML = '';
    for (const v of values) {
      const opt = document.createElement('option');
      opt.value = typeof v === 'object' ? v.value : v;
      opt.textContent = typeof v === 'object' ? v.label : labelFn(v);
      if (typeof v === 'object' && v.disabled) opt.disabled = true;
      el.appendChild(opt);
    }
    if (current !== undefined && [...el.options].some((o) => o.value === current)) el.value = current;
  }

  function voicesFor(provider) {
    return state?.options.providers.find((p) => p.id === provider)?.voices || [];
  }

  function renderForm() {
    const o = state.options;
    fillSelect('ltProvider', o.providers.map((p) => ({ value: p.id, label: p.label + (p.configured ? '' : ' (нет ключа)'), disabled: !p.configured })), draft.provider);
    fillSelect('ltVoice', voicesFor(draft.provider).map((v) => ({ value: v.id, label: v.name })), draft.voice);
    if ($('ltVoice').value !== draft.voice) draft.voice = $('ltVoice').value;
    fillSelect('ltPersona', o.personas.map((p) => ({ value: p.id, label: `${p.name} (${p.id})` })), draft.persona);
    fillSelect('ltMood', o.enums.mood, draft.mood);
    fillSelect('ltResponseLength', o.enums.responseLength, draft.responseLength);
    fillSelect('ltTone', o.enums.tone, draft.tone);
    fillSelect('ltExpertiseLevel', o.enums.expertiseLevel, draft.expertiseLevel);
    fillSelect('ltConversationMode', o.enums.conversationMode, draft.conversationMode);
    fillSelect('ltKnowledgeMode', o.knowledgeModes.map((k) => ({ value: k, label: KNOWLEDGE_LABELS[k] || k })), draft.knowledgeMode);
    renderChanges();
  }

  function renderChanges() {
    const published = state?.published?.config || null;
    const box = $('ltChanges');
    const changes = FIELDS.filter((f) => !published || published[f] !== draft[f]);
    if (published && !changes.length) {
      box.className = 'lt-changes lt-changes--none';
      box.textContent = 'Черновик совпадает с опубликованной конфигурацией.';
      $('ltApply').disabled = true;
      return;
    }
    box.className = 'lt-changes';
    box.innerHTML = '<b>Будет применено к НОВЫМ сессиям:</b><br>' + changes.map((f) => {
      const from = published ? published[f] : '—';
      return `${esc(LABELS[f])}: ${esc(from)} → <b>${esc(draft[f])}</b>`;
    }).join('<br>');
    $('ltApply').disabled = false;
  }

  function renderBanner() {
    const banner = $('ltBanner');
    if (!banner || !state) return;
    banner.hidden = false;
    const p = state.published;
    if (!p) {
      banner.classList.add('lt-banner--none');
      $('ltBannerDesc').textContent = 'НЕ ОПУБЛИКОВАНО — участники (/lite) получают обычные настройки';
      $('ltBannerMeta').textContent = '';
      return;
    }
    banner.classList.remove('lt-banner--none');
    $('ltBannerDesc').textContent = (p.label ? p.label + ' — ' : '') + describe(p.config);
    $('ltBannerMeta').textContent = `Published: ${new Date(p.published_at).toLocaleTimeString()} · Config revision: ${p.revision}`;
  }

  function renderPresets() {
    const box = $('ltPresets');
    box.innerHTML = '';
    for (const slot of state.options.presetSlots) {
      const preset = state.presets[slot];
      const div = document.createElement('div');
      div.className = 'lt-preset';
      div.innerHTML = `<b>${esc(slot)} · ${esc(preset.label)}</b><div class="lt-preset__desc">${esc(describe(preset.config))}</div>`;
      const load = document.createElement('button');
      load.type = 'button'; load.className = 'secondary'; load.textContent = 'Загрузить';
      load.addEventListener('click', () => {
        draft = { ...preset.config };
        draft._label = `${slot} · ${preset.label}`;
        renderForm();
        status(`Пресет ${slot} загружен в черновик. Нажмите APPLY TO NEW SESSIONS, чтобы опубликовать.`);
      });
      const save = document.createElement('button');
      save.type = 'button'; save.className = 'secondary'; save.textContent = 'Сохранить'; save.style.marginLeft = '6px';
      save.addEventListener('click', async () => {
        const label = window.prompt(`Название пресета ${slot}:`, preset.label);
        if (label === null) return;
        try {
          await api(`/api/live-test/presets/${slot}`, { method: 'POST', body: JSON.stringify({ label, config: cleanDraft() }) });
          status(`Пресет ${slot} сохранён.`);
          await load();
        } catch (error) { status('Ошибка: ' + error.message); }
      });
      div.appendChild(load); div.appendChild(save);
      box.appendChild(div);
    }
  }

  function renderHistory() {
    const body = $('ltHistory');
    if (!state.history.length) { body.innerHTML = '<tr><td colspan="4">Публикаций ещё не было.</td></tr>'; return; }
    body.innerHTML = state.history.slice(0, 15).map((h) => `<tr><td>${h.revision}</td><td>${esc(new Date(h.published_at).toLocaleTimeString())}</td><td>${esc(h.label || '')}</td><td>${h.changes.map((c) => `${esc(LABELS[c.field] || c.field)}: ${esc(c.from ?? '—')} → ${esc(c.to)}`).join('<br>') || 'без изменений'}</td></tr>`).join('');
  }

  async function loadResults() {
    try {
      const data = await api('/api/live-test/results');
      $('ltResultsByRev').innerHTML = data.by_revision.length ? data.by_revision.map((r) => `<tr><td>${r.config_revision}</td><td>${esc(r.label || '')}<br><span style="color:var(--muted)">${esc(r.description)}</span></td><td>${r.sessions}</td><td>${r.rated}</td><td>${r.avg_conversation ?? '—'}</td><td>${r.avg_voice ?? '—'}</td><td>${r.median_duration_s ?? '—'}</td><td>${r.median_turns ?? '—'}</td><td>${esc(r.languages.join(', '))}</td></tr>`).join('') : '<tr><td colspan="9">Тестовых сессий ещё нет.</td></tr>';
      $('ltSessions').innerHTML = data.sessions.length ? data.sessions.slice(0, 40).map((s) => `<tr><td>${esc(new Date(s.started_at).toLocaleTimeString())}</td><td>${s.config_revision}</td><td>${esc(s.config?.provider)} · ${esc(s.config?.resolved_voice || s.config?.voice)}</td><td>${s.duration_ms ? Math.round(s.duration_ms / 1000) : '—'}</td><td>${s.turn_count ?? '—'}</td><td>${esc(s.language || '')}</td><td>${esc(s.end_reason || '')}</td><td>${s.conversation_score ? `💬${s.conversation_score} 🔊${s.voice_score ?? '—'}` : '—'}</td><td>${esc(s.comment || '')}</td></tr>`).join('') : '<tr><td colspan="9">—</td></tr>';
    } catch (error) {
      $('ltResultsByRev').innerHTML = `<tr><td colspan="9">Ошибка: ${esc(error.message)}</td></tr>`;
    }
  }

  function status(text) { $('ltStatus').textContent = text; }

  function cleanDraft() {
    const out = {};
    for (const f of FIELDS) out[f] = draft[f];
    return out;
  }

  async function load() {
    state = await api('/api/live-test/state');
    if (!draft) draft = { ...(state.published?.config || state.baseline.config) };
    renderBanner();
    renderForm();
    renderPresets();
    renderHistory();
    // /lite needs the server-wide voice mode to be Free Conversation (the
    // realtime server reads it per session; Test Control does not change it).
    try {
      const persona = await fetch('/api/persona').then((r) => r.json());
      const warn = persona && persona.voiceMode && persona.voiceMode !== 'tap_to_start';
      $('ltBannerMeta').textContent += warn ? ' · ⚠ Режим голоса не Free Conversation — включите его в Talk → Voice mode' : '';
    } catch { /* ignore */ }
    const link = `${location.origin}/lite`;
    $('ltLiteLink').href = link;
    $('ltLiteLink').textContent = link;
  }

  function bind() {
    if (/^\/lite\/?$/.test(location.pathname) || new URLSearchParams(location.search).get('lite') === '1') return;
    for (const f of FIELDS) {
      $(SELECT_ID[f]).addEventListener('change', (e) => {
        draft[f] = e.target.value;
        delete draft._label;
        if (f === 'provider') {
          const voices = voicesFor(draft.provider);
          if (!voices.some((v) => v.id === draft.voice)) draft.voice = voices[0]?.id || '';
        }
        if (f === 'persona') {
          const persona = state.options.personas.find((p) => p.id === draft.persona);
          if (persona) status(`Персона ${persona.name}: остальные поля не меняются автоматически — проверьте их перед публикацией.`);
        }
        renderForm();
      });
    }
    $('ltApply').addEventListener('click', async () => {
      $('ltApply').disabled = true;
      status('Публикация…');
      try {
        const data = await api('/api/live-test/publish', { method: 'POST', body: JSON.stringify({ config: cleanDraft(), label: draft._label || 'manual' }) });
        status(`Опубликовано: revision ${data.published.revision}. Следующая новая сессия /lite получит эту конфигурацию.`);
        await load();
      } catch (error) {
        status('Не опубликовано: ' + error.message);
        renderChanges();
      }
    });
    $('ltResetBaseline').addEventListener('click', () => {
      draft = { ...state.baseline.config, _label: 'Baseline' };
      renderForm();
      status('Baseline загружен в черновик. Проверьте изменения и нажмите APPLY TO NEW SESSIONS.');
    });
    $('ltSaveBaseline').addEventListener('click', async () => {
      if (!window.confirm('Сохранить текущий черновик как baseline (проверенную конфигурацию)?')) return;
      try {
        await api('/api/live-test/baseline', { method: 'POST', body: JSON.stringify({ config: cleanDraft() }) });
        status('Baseline сохранён.');
        await load();
      } catch (error) { status('Ошибка: ' + error.message); }
    });
    $('ltRefresh').addEventListener('click', () => { load().catch(() => {}); loadResults(); });
    document.querySelector('nav.tabs [data-tab="livetest"]')?.addEventListener('click', () => {
      loadResults();
      if (!loadedOnce) { loadedOnce = true; }
    });
    load().catch((error) => {
      const banner = $('ltBanner');
      if (banner) { banner.hidden = false; banner.classList.add('lt-banner--none'); $('ltBannerDesc').textContent = 'Live Test: не удалось загрузить конфигурацию (' + error.message + ')'; }
    });
    setInterval(() => {
      if ($('tab-livetest')?.classList.contains('active')) { load().catch(() => {}); loadResults(); }
    }, 20000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
