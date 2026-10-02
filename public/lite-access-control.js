'use strict';

// Dashboard → Settings → "Временный доступ к WINE AI Lite".
// Admin API: /api/lite-access/codes (src/server.js, admin gate). The code is
// returned only once, at creation; the server keeps only its hash.
(function () {
  const card = document.getElementById('liteAccessCard');
  if (!card || /^\/lite\/?$/.test(location.pathname)) return;

  const $ = (id) => document.getElementById(id);
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const STATUS_COLOR = { ACTIVE: '#1f7a3a', EXPIRED: '#8a6d3b', REVOKED: '#b3261e' };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmt(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function remaining(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return '';
    const min = Math.round(ms / 60000);
    if (min < 60) return `ещё ${min} мин`;
    const h = Math.floor(min / 60);
    return h < 48 ? `ещё ${h} ч ${min % 60} мин` : `ещё ${Math.floor(h / 24)} дн`;
  }

  function generate() {
    const bytes = new Uint32Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  }

  function status(text, isError) {
    $('laStatus').textContent = text || '';
    $('laStatus').style.color = isError ? '#b3261e' : 'var(--muted)';
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const err = new Error((data.errors && data.errors.join(', ')) || data.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const ERROR_TEXT = {
    label_required: 'Укажите название (кому выдан доступ).',
    code_length_6_64: 'Код: от 6 до 64 символов.',
    expiry_in_future_required: 'Срок должен быть в будущем.',
    expiry_max_31_days: 'Срок — не больше 31 дня.',
    code_already_active: 'Такой код уже действует — выберите другой.',
  };

  function render(codes, enforced) {
    const tbody = $('laTable').querySelector('tbody');
    if (!codes.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted); padding:8px 0;">Пока нет кодов.</td></tr>';
    } else {
      tbody.innerHTML = codes.map((c) => `
        <tr style="border-top:1px solid var(--border);">
          <td style="padding:7px 6px 7px 0;">${escapeHtml(c.label)}</td>
          <td>${fmt(c.created_at)}</td>
          <td>${fmt(c.expires_at)}${c.status === 'ACTIVE' ? `<br><span style="font-size:11px; color:var(--muted);">${remaining(c.expires_at)}</span>` : ''}</td>
          <td><b style="color:${STATUS_COLOR[c.status] || 'inherit'};">${c.status}</b></td>
          <td>${c.use_count}${c.last_used_at ? `<br><span style="font-size:11px; color:var(--muted);">${fmt(c.last_used_at)}</span>` : ''}</td>
          <td style="white-space:nowrap;">
            ${c.status === 'ACTIVE' ? `<button type="button" class="secondary" data-revoke="${escapeHtml(c.id)}" style="margin:0 4px 0 0;">Отозвать</button>` : ''}
            <button type="button" class="secondary" data-delete="${escapeHtml(c.id)}" style="margin:0;">Удалить</button>
          </td>
        </tr>`).join('');
    }
    if (!enforced) status('Внимание: защита /lite сейчас выключена (LITE_ACCESS_ENFORCED=0 или не production) — /lite открыт всем.', true);
  }

  async function refresh() {
    try {
      const data = await api('GET', '/api/lite-access/codes');
      render(data.codes || [], data.enforced !== false);
    } catch (error) {
      status(`Не удалось загрузить коды: ${error.message}`, true);
    }
  }

  function showCreated(code, entry) {
    const link = `${location.origin}/lite`;
    const message = `WINE AI — тестовый доступ\nСсылка: ${link}\nКод: ${code}\nДействует до: ${fmt(entry.expires_at)}`;
    const box = $('laCreated');
    box.style.display = '';
    box.innerHTML = `
      <div style="font-size:12px; color:var(--muted);">Код для «${escapeHtml(entry.label)}» — показывается один раз:</div>
      <div style="font:600 22px/1.3 ui-monospace, Menlo, monospace; letter-spacing:.12em; margin:6px 0;">${escapeHtml(code)}</div>
      <div style="font-size:12px; margin-bottom:8px;">${escapeHtml(link)} · до ${fmt(entry.expires_at)}</div>
      <button type="button" class="btn-icon primary" id="laCopyMessage" style="margin:0 6px 0 0;">Скопировать ссылку + код</button>
      <button type="button" class="secondary" id="laCopyCode" style="margin:0;">Скопировать код</button>`;
    const copy = async (text, button) => {
      try { await navigator.clipboard.writeText(text); button.textContent = 'Скопировано ✓'; } catch { window.prompt('Скопируйте:', text); }
    };
    $('laCopyMessage').addEventListener('click', (e) => copy(message, e.currentTarget));
    $('laCopyCode').addEventListener('click', (e) => copy(code, e.currentTarget));
  }

  $('laGenerate').addEventListener('click', () => { $('laCode').value = generate(); });
  $('laLifetime').addEventListener('change', () => {
    $('laUntilWrap').style.display = $('laLifetime').value === 'until' ? '' : 'none';
  });

  $('laCreate').addEventListener('click', async () => {
    const lifetime = $('laLifetime').value;
    const body = { label: $('laLabel').value.trim(), code: $('laCode').value.trim() || undefined };
    if (lifetime === 'until') {
      const until = $('laUntil').value;
      if (!until) { status('Укажите дату и время окончания.', true); return; }
      body.expires_at = new Date(until).toISOString();
    } else {
      body.expires_in_minutes = Number(lifetime);
    }
    $('laCreate').disabled = true;
    status('Создаю…');
    try {
      const data = await api('POST', '/api/lite-access/codes', body);
      showCreated(data.code, data.entry);
      $('laLabel').value = '';
      $('laCode').value = '';
      status('');
      await refresh();
    } catch (error) {
      status(error.message.split(', ').map((e) => ERROR_TEXT[e] || e).join(' '), true);
    } finally {
      $('laCreate').disabled = false;
    }
  });

  $('laTable').addEventListener('click', async (event) => {
    const revoke = event.target.closest('[data-revoke]');
    const del = event.target.closest('[data-delete]');
    try {
      if (revoke) {
        if (!window.confirm('Отозвать доступ? Код перестанет работать сразу.')) return;
        await api('POST', `/api/lite-access/codes/${encodeURIComponent(revoke.dataset.revoke)}/revoke`);
      } else if (del) {
        if (!window.confirm('Удалить запись? Если код активен, он перестанет работать.')) return;
        await api('DELETE', `/api/lite-access/codes/${encodeURIComponent(del.dataset.delete)}`);
      } else {
        return;
      }
      await refresh();
    } catch (error) {
      status(`Ошибка: ${error.message}`, true);
    }
  });

  refresh();
  setInterval(refresh, 60000);
})();
