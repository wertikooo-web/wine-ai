'use strict';

// Admin: is the voice provider usable? GET /api/provider-health?probe=1.
// Exits 1 when the Gemini probe fails (credits depleted, bad key) or a
// session hit a quota/auth error in the last PROVIDER_HEALTH_MINUTES (35):
// the scheduled provider-health workflow then fails and GitHub e-mails.
//   ADMIN_TOKEN=... node scripts/diag/provider-health.js
// Runbook: docs/RUNBOOK_PROVIDER_DOWN.md

const BASE_URL = String(process.env.BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHealth() {
    const minutes = process.env.PROVIDER_HEALTH_MINUTES || '35';
    // a deploy restart answers 502 for a minute: retry before alarming
    let last = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const res = await fetch(`${BASE_URL}/api/provider-health?probe=1&minutes=${minutes}`, { headers: { 'x-admin-token': process.env.ADMIN_TOKEN || '' } });
            if (res.ok) return res.json();
            last = new Error(`HTTP ${res.status}`);
            if (res.status === 401) break;
        } catch (error) {
            last = error;
        }
        if (attempt < 3) await sleep(30000);
    }
    throw last;
}

(async () => {
    const h = await fetchHealth();
    console.log(JSON.stringify(h, null, 2));
    if (h.ok) {
        console.log('\nOK: provider usable');
        return;
    }
    const why = h.probe && !h.probe.ok ? `probe ${h.probe.kind}: ${h.probe.error}` : `sessions: ${JSON.stringify(h.sessions.counts)}`;
    console.error(`\n::error::Voice provider problem (${why}). Runbook: docs/RUNBOOK_PROVIDER_DOWN.md. Grok key configured: ${h.grok_configured}`);
    process.exit(1);
})().catch((error) => {
    console.error(`::error::provider-health unreachable: ${error.message}`);
    process.exit(1);
});
