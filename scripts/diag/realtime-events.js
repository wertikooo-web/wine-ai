'use strict';

// Admin: recent Gemini connections (speech languageCode) and language
// switches from production (GET /api/diag/realtime-events), newest last.
//   ADMIN_TOKEN=... node scripts/diag/realtime-events.js

const BASE_URL = String(process.env.BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');

(async () => {
    const res = await fetch(`${BASE_URL}/api/diag/realtime-events`, { headers: { 'x-admin-token': process.env.ADMIN_TOKEN || '' } });
    const body = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(body)}`);
    console.log(`GEMINI_SPEECH_LANGUAGE_CODE=${body.speech_language_code_env}`);
    for (const e of body.events || []) console.log(JSON.stringify(e));
})().catch((error) => { console.error(error.message); process.exit(1); });
