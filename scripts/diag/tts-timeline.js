'use strict';

// Production diagnostic (read-only): when did the Gemini TTS calls this
// month happen? Bridge phrase prewarm renders 10 phrases per voice in one
// burst right after a session connects; voice previews are single calls.
// Narrows day -> 10 min -> 1 min using /api/cost/breakdown ranges.

const BASE_URL = String(process.env.BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');

async function ttsCount(from, to) {
    const url = `${BASE_URL}/api/cost/breakdown?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (res.status !== 200) throw new Error(`breakdown http ${res.status} ${body.error || ''}`);
    return (body.by_provider_model || []).filter((r) => /tts/i.test(r.model || '')).reduce((n, r) => n + r.records, 0);
}

async function split(from, to, stepMs) {
    const out = [];
    for (let t = from.getTime(); t < to.getTime(); t += stepMs) {
        const a = new Date(t);
        const b = new Date(Math.min(to.getTime(), t + stepMs) - 1);
        const n = await ttsCount(a, b);
        if (n > 0) out.push({ from: a, to: b, n });
    }
    return out;
}

async function main() {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 3 * 3600 * 1000);
    console.log(`TTS records this month: ${await ttsCount(monthStart, now)}`);
    const days = await split(monthStart, now, 24 * 3600 * 1000);
    for (const d of days) {
        const tens = await split(d.from, d.to, 10 * 60 * 1000);
        for (const t of tens) {
            const mins = await split(t.from, t.to, 60 * 1000);
            for (const m of mins) console.log(`${m.from.toISOString()}  tts_calls=${m.n}`);
        }
    }
}

main().catch((error) => { console.error(error); process.exit(1); });
