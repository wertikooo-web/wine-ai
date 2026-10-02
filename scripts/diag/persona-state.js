'use strict';

// Production persona state (read-only): which character /lite sessions get
// and from where -- the active Settings profile, each profile's saved name /
// gender / voice overrides, the published Live Test revision (which wins
// over Settings for /lite), and what /api/lite/config shows.
//
//   ADMIN_TOKEN=... node scripts/diag/persona-state.js

const BASE_URL = String(process.env.BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_TOKEN || '';

async function get(path) {
    const res = await fetch(`${BASE_URL}${path}`, { headers: { 'x-admin-token': TOKEN } });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
}

const NAMES = /Александр|Alexandru|Alexander|Мария|Maria/g;
const namesIn = (text) => [...new Set(String(text || '').match(NAMES) || [])].join(',') || '-';

async function main() {
    const active = await get('/api/persona');
    console.log(`active_profile=${active.activeProfileId}`);
    for (const id of ['warm_guide', 'classic']) {
        const p = await get(`/api/persona?profileId=${id}`);
        const o = p.overrides || {};
        console.log(`profile=${id} name=${p.name} gender=${p.sommelierGender} mood=${p.mood}`
            + ` override_keys=${Object.keys(o).join(',') || '-'}`
            + ` override_name=${o.name || '-'}`
            + ` override_voices=${JSON.stringify(o.runtimeByProvider || {})}`
            + ` default_voices=${JSON.stringify(p.resolved?.runtimeByProvider || {})}`
            + ` system_prompt_override=${o.systemPrompt !== undefined} names_in_prompt=${namesIn(p.effectivePromptPreview)}`
            + ` names_in_welcome=${namesIn(p.welcome_message)} identity_names=${namesIn(JSON.stringify(o.identity || {}))}`);
    }
    const lt = await get('/api/live-test/state');
    const pub = lt.published;
    if (pub && pub.config) {
        const c = pub.config;
        const po = c.personaOverrides || {};
        console.log(`live_test_published revision=${pub.revision} label=${pub.label} persona=${c.persona} provider=${c.provider} voice=${c.voice}`
            + ` frozen_override_name=${po.name || '-'} frozen_names=${namesIn(JSON.stringify(po))}`);
    } else {
        console.log('live_test_published=none (sessions use Settings)');
    }
    const lite = await get('/api/lite/config');
    console.log(`lite_config persona=${lite.persona?.id} name=${lite.persona?.display_name} source=${lite.persona?.source}`);
}

main().catch((error) => { console.error(error.message); process.exit(1); });
