// Dashboard → Расходы / Cost Control. Reads /api/cost/* only; renders with
// textContent / escaped strings. No secrets, prompts or transcripts are ever
// requested or shown.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let loadedOnce = false;
  let state = { summary: null, settings: null, pricing: [], fixed: [], categoryLabels: {} };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function money(value, currency) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    const v = Number(value);
    const abs = Math.abs(v);
    const digits = abs === 0 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v) + ' ' + currency;
  }

  function duration(ms) {
    const total = Math.round((Number(ms) || 0) / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h} ч ${m} мин`;
    if (m > 0) return `${m} мин ${s} с`;
    return `${s} с`;
  }

  function badge(basis) {
    const b = String(basis || 'estimated').toLowerCase();
    const cls = { actual: 'actual', estimated: 'estimated', manual: 'manual', unpriced: 'unpriced' }[b] || 'estimated';
    return `<span class="cc-badge cc-badge--${cls}">${esc(b.toUpperCase())}</span>`;
  }

  function adminHeaders() {
    let token = '';
    try { token = sessionStorage.getItem('wineAiAdminToken') || ''; } catch { /* storage unavailable */ }
    return token ? { 'x-admin-token': token } : {};
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { 'content-type': 'application/json', ...adminHeaders(), ...(options.headers || {}) },
    });
    if (response.status === 401) {
      const token = window.prompt('Admin token required to change cost settings:');
      if (token) {
        try { sessionStorage.setItem('wineAiAdminToken', token); } catch { /* ignore */ }
        return api(path, options);
      }
    }
    const data = await response.json().catch(() => ({ ok: false, error: 'invalid_response' }));
    if (!response.ok || data.ok === false) throw new Error(data.error || `http_${response.status}`);
    return data;
  }

  function rangeQuery() {
    const from = $('ccFrom').value;
    const to = $('ccTo').value;
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const q = params.toString();
    return q ? `?${q}` : '';
  }

  function card({ label, mdl, eur, meta, main = false, basis }) {
    return `<div class="cc-card${main ? ' cc-card--main' : ''}">
      <div class="cc-card__label">${esc(label)} ${basis ? badge(basis) : ''}</div>
      <div class="cc-card__value">${esc(mdl)}</div>
      <div class="cc-card__eur">${esc(eur)}</div>
      <div class="cc-card__meta">${meta}</div>
    </div>`;
  }

  function renderCards(s) {
    const t = s.periods.today;
    const w = s.periods.last_7_days;
    const m = s.periods.month;
    const b = s.budget;
    const avgMdl = m.avg_cost_per_conversation_mdl;
    const avgEur = m.avg_cost_per_conversation_eur;
    $('ccCards').innerHTML = [
      card({ label: 'Сегодня', mdl: money(t.cost_mdl, 'MDL'), eur: money(t.cost_eur, 'EUR'), basis: t.basis,
        meta: `${t.conversations} разговоров · ${duration(t.conversation_duration_ms)}<br>AI/API usage` }),
      card({ label: '7 дней', mdl: money(w.cost_mdl, 'MDL'), eur: money(w.cost_eur, 'EUR'), basis: w.basis,
        meta: `${w.conversations} разговоров · ${duration(w.conversation_duration_ms)}<br>AI/API usage` }),
      card({ label: 'Этот месяц', main: true, mdl: money(m.total_cost_mdl, 'MDL'), eur: money(m.total_cost_eur, 'EUR'),
        meta: `AI/API: ${esc(money(m.api_cost_mdl, 'MDL'))} ${badge(m.basis)}<br>Инфраструктура: ${esc(money(m.fixed_cost_mdl, 'MDL'))} ${badge('manual')}<br>Прогноз: ${esc(money(m.projected_total_cost_mdl, 'MDL'))}` }),
      card({ label: 'Средний разговор', mdl: money(avgMdl, 'MDL'), eur: money(avgEur, 'EUR'), basis: m.basis,
        meta: `AI/API cost ÷ ${m.conversations} разговоров за месяц` }),
      card({ label: 'Бюджет месяца', mdl: b.configured ? `${b.percent_used}%` : 'не задан', eur: b.configured ? `из ${money(b.budget_mdl, 'MDL')}` : 'задайте в настройках ниже',
        meta: b.configured ? `Прогноз: ${b.projected_percent}% · ${esc(money(b.projected_mdl, 'MDL'))}` : 'Только наблюдение' }),
    ].join('');
  }

  function renderBudget(s) {
    const b = s.budget;
    const m = s.periods.month;
    const warn = $('ccBudgetWarning');
    if (b.configured && ['warning', 'critical', 'exceeded'].includes(b.level)) {
      const text = b.level === 'exceeded'
        ? `Бюджет месяца превышен: ${b.percent_used}% (порог ${b.crossed_threshold}%). Разговоры не ограничиваются — это только предупреждение.`
        : `Использовано ${b.percent_used}% бюджета месяца (порог ${b.crossed_threshold}%).`;
      warn.innerHTML = `<div class="cc-warn cc-warn--${esc(b.level)}">${esc(text)}</div>`;
    } else if (b.configured && b.projected_over_budget) {
      warn.innerHTML = `<div class="cc-warn cc-warn--warning">${esc(`Прогноз на конец месяца (${money(b.projected_mdl, 'MDL')}) превышает бюджет.`)}</div>`;
    } else {
      warn.innerHTML = '';
    }
    if (!b.configured) {
      $('ccBudget').innerHTML = `<p class="cc-muted">Бюджет не задан. Использовано в этом месяце: <strong>${esc(money(b.used_mdl, 'MDL'))}</strong>; прогноз: <strong>${esc(money(b.projected_mdl, 'MDL'))}</strong>.</p>`;
      return;
    }
    const pct = Math.min(100, Math.max(0, b.percent_used || 0));
    const markers = (b.thresholds || []).filter((x) => x < 100).map((x) => `<span class="cc-progress__marker" style="left:${x}%"></span>`).join('');
    $('ccBudget').innerHTML = `
      <div><strong>${esc(money(b.used_mdl, 'MDL'))}</strong> из ${esc(money(b.budget_mdl, 'MDL'))} · <strong>${esc(b.percent_used)}%</strong> · ${esc(Math.round(m.elapsed_fraction * 100))}% месяца прошло</div>
      <div class="cc-progress"><div class="cc-progress__bar ${esc(b.level)}" style="width:${pct}%"></div>${markers}</div>
      <div class="cc-muted" style="font-size:12px;">Прогноз на конец месяца: <strong>${esc(money(b.projected_mdl, 'MDL'))}</strong> (${esc(b.projected_percent)}%) = AI/API ${esc(money(m.projected_api_cost_mdl, 'MDL'))} ${badge('estimated')} + инфраструктура ${esc(money(m.fixed_cost_mdl, 'MDL'))} ${badge('manual')}. Пороги: ${esc((b.thresholds || []).join('%, '))}%.</div>`;
  }

  function renderCustomer(s) {
    const c = s.customer_summary;
    const items = [
      ['Разговоры / Conversations', String(c.conversations), ''],
      ['Время разговоров / Conversation time', duration(c.total_conversation_time_ms), ''],
      ['AI/API стоимость', money(c.ai_api_cost_mdl, 'MDL'), money(c.ai_api_cost_eur, 'EUR')],
      ['Инфраструктура', money(c.infrastructure_cost_mdl, 'MDL'), money(c.infrastructure_cost_eur, 'EUR')],
      ['Итого операционные расходы', money(c.total_operational_cost_mdl, 'MDL'), money(c.total_operational_cost_eur, 'EUR')],
      ['Средняя стоимость разговора', money(c.avg_cost_per_conversation_mdl, 'MDL'), money(c.avg_cost_per_conversation_eur, 'EUR')],
    ];
    $('ccCustomerList').innerHTML = items.map(([k, v, sub]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}${sub ? `<small>${esc(sub)}</small>` : ''}</dd></div>`).join('');
  }

  function usageText(usage) {
    const u = usage || {};
    const parts = [];
    const tokIn = (u.input_text_tokens || 0) + (u.input_audio_tokens || 0) + (u.input_other_tokens || 0);
    const tokOut = (u.output_text_tokens || 0) + (u.output_audio_tokens || 0) + (u.output_other_tokens || 0);
    if (tokIn || tokOut) parts.push(`${Math.round(tokIn).toLocaleString('ru-RU')} in / ${Math.round(tokOut).toLocaleString('ru-RU')} out tok`);
    if (u.input_audio_tokens || u.output_audio_tokens) parts.push(`audio ${Math.round(u.input_audio_tokens || 0)}/${Math.round(u.output_audio_tokens || 0)} tok`);
    if (u.audio_input_seconds || u.audio_output_seconds) parts.push(`audio ${Math.round(u.audio_input_seconds || 0)}s in / ${Math.round(u.audio_output_seconds || 0)}s out`);
    if (u.billable_seconds && !tokIn && !tokOut) parts.push(`${(u.billable_seconds / 60).toFixed(2)} min`);
    if (u.requests) parts.push(`${u.requests} req`);
    if (u.input_chars) parts.push(`${Math.round(u.input_chars).toLocaleString('ru-RU')} chars`);
    return parts.join(' · ') || '—';
  }

  function breakdownTable(el, rows, firstCol) {
    if (!rows.length) {
      el.innerHTML = '<tbody><tr><td class="cc-muted">Нет данных за период</td></tr></tbody>';
      return;
    }
    el.innerHTML = `<thead><tr><th>${esc(firstCol)}</th><th class="num">Записей</th><th>Usage</th><th class="num">MDL</th><th class="num">EUR</th><th>Basis</th></tr></thead><tbody>${
      rows.map((r) => `<tr>
        <td>${r.category ? esc(r.label || r.category) : `${esc(r.provider)}<br><span class="cc-muted">${esc(r.model || '—')}</span>`}</td>
        <td class="num">${esc(r.records)}${r.conversations ? `<br><span class="cc-muted">${esc(r.conversations)} разг.</span>` : ''}</td>
        <td>${esc(usageText(r.usage))}</td>
        <td class="num">${esc(money(r.cost_mdl, 'MDL'))}</td>
        <td class="num">${esc(money(r.cost_eur, 'EUR'))}</td>
        <td>${badge(r.basis)}${r.unpriced_records ? ` ${badge('unpriced')} <span class="cc-muted">${esc(r.unpriced_records)}</span>` : ''}</td>
      </tr>`).join('')}</tbody>`;
  }

  function renderSessions(sessions) {
    const el = $('ccSessions');
    if (!sessions.length) {
      el.innerHTML = '<tbody><tr><td class="cc-muted">Пока нет завершённых сессий. Запись появляется после окончания разговора.</td></tr></tbody>';
      return;
    }
    el.innerHTML = `<thead><tr><th>Время</th><th>Длительность</th><th>Provider / model</th><th class="num">Реплик</th><th>Usage</th><th class="num">MDL</th><th class="num">EUR</th><th>Basis</th><th>Статус</th></tr></thead><tbody>${
      sessions.map((s) => `<tr>
        <td>${esc(new Date(s.started_at).toLocaleString('ru-RU'))}</td>
        <td>${esc(duration(s.duration_ms))}</td>
        <td>${esc(s.provider)}<br><span class="cc-muted">${esc(s.model || '—')}</span></td>
        <td class="num">${esc(s.turn_count)}</td>
        <td>${esc(usageText(s.usage))}</td>
        <td class="num">${esc(s.priced ? money(s.cost_mdl, 'MDL') : '—')}</td>
        <td class="num">${esc(s.priced ? money(s.cost_eur, 'EUR') : '—')}</td>
        <td>${s.priced ? badge(s.cost_basis) : badge('unpriced')}</td>
        <td>${esc(s.status)}<br><span class="cc-muted">${esc(s.end_reason || '')}</span></td>
      </tr>`).join('')}</tbody>`;
  }

  function renderFixed() {
    const el = $('ccFixed');
    const rows = state.fixed;
    if (!rows.length) {
      el.innerHTML = '<tbody><tr><td class="cc-muted">Нет постоянных расходов. Добавьте Railway, PostgreSQL и т.д.</td></tr></tbody>';
      return;
    }
    el.innerHTML = `<thead><tr><th>Название</th><th>Категория</th><th class="num">Сумма / мес</th><th></th></tr></thead><tbody>${
      rows.map((f) => `<tr>
        <td>${esc(f.name)} ${f.active === false ? '<span class="cc-muted">(off)</span>' : ''}</td>
        <td>${esc(f.category)}</td>
        <td class="num">${esc(money(f.amount, f.currency))} ${badge('manual')}</td>
        <td><button class="cc-btn cc-btn--ghost" type="button" data-fixed-delete="${esc(f.id)}">Удалить</button></td>
      </tr>`).join('')}</tbody>`;
  }

  function renderPricing() {
    const el = $('ccPricing');
    const today = new Date().toISOString().slice(0, 10);
    // Same rule as the server: newest effective_from <= today wins.
    const activeIds = new Map();
    for (const p of state.pricing) {
      if (p.effective_from > today || (p.effective_to && p.effective_to <= today)) continue;
      const key = `${p.provider}|${p.model}|${p.category}`;
      const current = activeIds.get(key);
      if (!current || current.effective_from < p.effective_from) activeIds.set(key, p);
    }
    const activeSet = new Set([...activeIds.values()].map((p) => p.id));
    el.innerHTML = `<thead><tr><th>Provider / model</th><th>Category</th><th>Unit</th><th>Prices</th><th>Effective</th><th>Source</th></tr></thead><tbody>${
      state.pricing.map((p) => {
        const active = activeSet.has(p.id);
        const prices = Object.entries(p.unit_prices || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
        return `<tr${active ? '' : ' class="cc-muted"'}>
          <td>${esc(p.provider)}<br><span class="cc-muted">${esc(p.model)}</span></td>
          <td>${esc(state.categoryLabels[p.category] || p.category)}</td>
          <td>${esc(p.billing_unit)} · ${esc(p.currency)}</td>
          <td style="font-size:12px;">${esc(prices)}</td>
          <td>${esc(p.effective_from)} → ${esc(p.effective_to || '…')}${active ? ' <strong>(active)</strong>' : ''}</td>
          <td style="font-size:12px;" class="cc-muted">${esc(p.source_note || '')}</td>
        </tr>`;
      }).join('')}</tbody>`;
    const select = $('ccPricingCategory');
    if (select && !select.options.length) {
      select.innerHTML = Object.entries(state.categoryLabels).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
    }
  }

  function renderSettings() {
    const s = state.settings;
    const form = $('ccSettingsForm');
    if (!s || !form) return;
    form.monthly_budget_mdl.value = s.monthly_budget_mdl ?? '';
    form.eur_to_mdl.value = s.eur_to_mdl ?? '';
    form.usd_to_eur.value = s.usd_to_eur ?? '';
    form.warning_thresholds.value = (s.warning_thresholds || []).join(',');
    form.rates_confirmed.checked = s.rates_confirmed === true;
  }

  async function load() {
    $('ccSubtitle').textContent = 'Загрузка…';
    try {
      const [summary, settings, pricing, fixed] = await Promise.all([
        api('/api/cost/summary' + rangeQuery()),
        api('/api/cost/settings'),
        api('/api/cost/pricing'),
        api('/api/cost/fixed-costs'),
      ]);
      state = { summary, settings: settings.settings, pricing: pricing.pricing, fixed: fixed.fixed_costs, categoryLabels: pricing.category_labels || {} };
      renderCards(summary);
      renderBudget(summary);
      renderCustomer(summary);
      breakdownTable($('ccByProvider'), summary.breakdown.by_provider_model, 'Provider / model');
      breakdownTable($('ccByCategory'), summary.breakdown.by_category, 'Категория');
      const sessions = rangeQuery()
        ? (await api('/api/cost/sessions' + rangeQuery() + (rangeQuery() ? '&' : '?') + 'limit=50')).sessions
        : summary.recent_sessions;
      renderSessions(sessions);
      renderFixed();
      renderPricing();
      renderSettings();
      const rateNote = summary.rates.confirmed ? '' : ' · курс не подтверждён';
      const storageNote = settings.persistent ? '' : ' · ВНИМАНИЕ: хранилище в памяти (нет PostgreSQL)';
      $('ccSubtitle').textContent = `Месяц ${summary.periods.month.month} · ${summary.timezone} · 1 EUR = ${summary.rates.eur_to_mdl} MDL · 1 USD = ${summary.rates.usd_to_eur} EUR${rateNote}${storageNote} · обновлено ${new Date(summary.generated_at).toLocaleTimeString('ru-RU')}`;
      loadedOnce = true;
    } catch (error) {
      $('ccSubtitle').textContent = 'Не удалось загрузить данные о расходах: ' + error.message;
    }
  }

  function bind() {
    const tabButton = document.querySelector('nav.tabs [data-tab="cost"]');
    if (tabButton) tabButton.addEventListener('click', () => { load(); });
    $('ccRefresh').addEventListener('click', load);
    $('ccApplyRange').addEventListener('click', load);

    $('ccFixedForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target;
      $('ccFixedStatus').textContent = 'Сохранение…';
      try {
        await api('/api/cost/fixed-costs', { method: 'POST', body: JSON.stringify({
          name: form.elements.namedItem('name').value, amount: Number(form.amount.value), currency: form.currency.value, category: form.category.value,
        }) });
        form.reset();
        $('ccFixedStatus').textContent = 'Сохранено';
        load();
      } catch (error) {
        $('ccFixedStatus').textContent = 'Ошибка: ' + error.message;
      }
    });

    $('ccFixed').addEventListener('click', async (event) => {
      const id = event.target?.dataset?.fixedDelete;
      if (!id) return;
      if (!window.confirm('Удалить этот постоянный расход?')) return;
      try {
        await api('/api/cost/fixed-costs/' + encodeURIComponent(id), { method: 'DELETE' });
        load();
      } catch (error) {
        $('ccFixedStatus').textContent = 'Ошибка: ' + error.message;
      }
    });

    $('ccSettingsForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target;
      $('ccSettingsStatus').textContent = 'Сохранение…';
      try {
        await api('/api/cost/settings', { method: 'PUT', body: JSON.stringify({
          monthly_budget_mdl: form.monthly_budget_mdl.value === '' ? null : Number(form.monthly_budget_mdl.value),
          eur_to_mdl: Number(form.eur_to_mdl.value),
          usd_to_eur: Number(form.usd_to_eur.value),
          warning_thresholds: form.warning_thresholds.value.split(',').map((x) => Number(x.trim())).filter((x) => x > 0),
          rates_confirmed: form.rates_confirmed.checked,
        }) });
        $('ccSettingsStatus').textContent = 'Сохранено';
        load();
      } catch (error) {
        $('ccSettingsStatus').textContent = 'Ошибка: ' + error.message;
      }
    });

    $('ccPricingForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target;
      let unitPrices;
      try { unitPrices = JSON.parse(form.unit_prices.value); } catch {
        $('ccPricingStatus').textContent = 'Unit prices: неверный JSON';
        return;
      }
      $('ccPricingStatus').textContent = 'Сохранение…';
      try {
        await api('/api/cost/pricing', { method: 'POST', body: JSON.stringify({
          provider: form.provider.value, model: form.model.value, category: form.category.value,
          billing_unit: form.billing_unit.value, currency: form.currency.value, unit_prices: unitPrices,
          effective_from: form.effective_from.value, source_note: form.source_note.value,
        }) });
        $('ccPricingStatus').textContent = 'Сохранено. Новая цена применяется к использованию с указанной даты; более ранние даты считаются по предыдущей версии.';
        load();
      } catch (error) {
        $('ccPricingStatus').textContent = 'Ошибка: ' + error.message;
      }
    });

    // Auto-refresh while the tab is open.
    setInterval(() => {
      if (loadedOnce && $('tab-cost')?.classList.contains('active')) load();
    }, 60000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
