'use strict';

// Production diagnostic: render the exact bridge phrases through the same
// Gemini TTS path (/api/voice-preview -> synthesizeVoicePreview) with the
// voices the personas use, and report which come back without audio.
// The bridge cache skips any phrase whose render returned no audio.

const { PHRASES } = require('../../src/realtime/bridgePhrases');

const BASE_URL = String(process.env.BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');

async function get(p) {
    const res = await fetch(`${BASE_URL}${p}`, { headers: process.env.ADMIN_TOKEN ? { 'x-admin-token': process.env.ADMIN_TOKEN } : {} });
    return { status: res.status, json: await res.json().catch(() => null) };
}

function collectVoiceStrings(value, names, out, pathKey = '') {
    if (value == null) return;
    if (typeof value === 'string') { if (names.has(value) && /voice/i.test(pathKey)) out.add(value); return; }
    if (typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value)) collectVoiceStrings(v, names, out, `${pathKey}.${k}`);
}

async function main() {
    const voices = await get('/api/voices');
    const geminiNames = new Set(((voices.json?.providers || []).find((p) => p.id === 'gemini')?.voices || voices.json?.voices || []).map((v) => v.id || v.name).filter(Boolean));
    const active = await get('/api/persona');
    const found = new Set();
    for (const id of ['', '?profileId=classic', '?profileId=warm_guide']) {
        const r = id ? await get(`/api/persona${id}`) : active;
        collectVoiceStrings(r.json, geminiNames, found);
    }
    console.log(`active profile=${active.json?.activeProfileId || active.json?.profileId || '?'}; gemini voice names known=${geminiNames.size}; persona voices found=${[...found].join(',') || 'none'}`);
    const targets = found.size ? [...found] : ['Kore'];
    for (const voice of targets) {
        for (const [lang, list] of Object.entries(PHRASES)) {
            for (const text of list) {
                const res = await fetch(`${BASE_URL}/api/voice-preview`, { method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.ADMIN_TOKEN ? { 'x-admin-token': process.env.ADMIN_TOKEN } : {}) }, body: JSON.stringify({ provider: 'gemini', voice_name: voice, text }) });
                const body = await res.json().catch(() => ({}));
                const ms = body.audio_base64 ? Math.round(Buffer.from(body.audio_base64, 'base64').length / 2 / (body.sample_rate || 24000) * 1000) : 0;
                console.log(`voice=${voice} lang=${lang} http=${res.status} ${body.error ? 'error=' + body.error : ''} audio_ms=${ms} text="${text}"`);
            }
        }
    }
}

main().catch((error) => { console.error(error); process.exit(1); });
