'use strict';

// Admin: recent turns from the turn journal (GET /api/turns), newest first.
//   ADMIN_TOKEN=... TURNS_LIMIT=50 [TURNS_SESSION=session_...] [TURNS_FLAGGED=1] node scripts/diag/turns.js
// TURNS_FLAGGED=1 prints only turns whose answer named something not found
// in the catalog / registry (flags.unverified_names).

const BASE_URL = String(process.env.BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');

(async () => {
    const q = new URLSearchParams({ limit: String(process.env.TURNS_LIMIT || 50) });
    if (process.env.TURNS_SESSION) q.set('session', process.env.TURNS_SESSION);
    const res = await fetch(`${BASE_URL}/api/turns?${q}`, { headers: { 'x-admin-token': process.env.ADMIN_TOKEN || '' } });
    const body = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    const flagged = body.turns.filter((t) => t.flags && Array.isArray(t.flags.unverified_names) && t.flags.unverified_names.length);
    console.log(`turns=${body.count} cost_usd=${body.cost_usd} unverified_names_turns=${flagged.length}`);
    for (const t of (process.env.TURNS_FLAGGED === '1' ? flagged : body.turns)) {
        const tools = (t.tools || []).map((x) => `${x.name}(${x.ms}ms${x.levels && x.levels.length ? ' ' + x.levels.join('+') : ''}${x.web ? ' web' : ''}${x.evidence && x.evidence.length ? ' ev=' + x.evidence.length : ''})`).join(', ');
        const u = t.usage || {};
        console.log(`\n${t.started_at} ${t.session_id} ${t.channel}/${t.language || '-'} ${t.outcome}${t.outcome_reason ? ':' + t.outcome_reason : ''} first_audio=${t.first_audio_ms ?? '-'}ms total=${t.total_ms}ms in=${Math.round((u.input_text_tokens || 0) + (u.input_audio_tokens || 0))} out=${Math.round((u.output_audio_tokens || 0) + (u.output_text_tokens || 0))} $${t.cost_usd ?? '-'} flags=${JSON.stringify(t.flags || {})}`);
        if (tools) console.log(`  tools: ${tools}`);
        console.log(`  Q: ${t.question || ''}`);
        console.log(`  A: ${t.answer || ''}`);
    }
})().catch((error) => { console.error(error.message); process.exit(1); });
