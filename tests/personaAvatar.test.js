'use strict';

// Persona avatar: name + avatar come from the persona only (never provider
// or voice), one asset source (/persona-assets) for /lite, the WineMD widget
// and the dashboard, per-session snapshot semantics, and a safe fallback.
// Boots the real server (memory storage, placeholder provider keys: no
// provider connection is needed to resolve the display persona).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const t = require('./helpers/assertions');
const { personaDisplay, FALLBACK_AVATAR_SRC, BUILTIN_PROFILES } = require('../src/persona/profileRegistry');
const { connect } = require('./helpers/wsTestClient');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
    // ---- pure resolution ------------------------------------------------------
    const exists = (set) => (file) => set.includes(file);
    t.equal(personaDisplay('warm_guide', { fileExists: exists(['personas/maria.png']) }).avatarUrl, '/persona-assets/maria.png', 'Maria -> maria.png');
    t.equal(personaDisplay('classic', { fileExists: exists(['personas/alexander.jpg']) }).avatarUrl, '/persona-assets/alexander.jpg', 'Alexander -> alexander.jpg (any supported extension)');
    const missing = personaDisplay('classic', { fileExists: () => false });
    t.equal(missing.avatarUrl, FALLBACK_AVATAR_SRC, 'missing asset -> safe fallback');
    t.equal(missing.displayName, 'Александр', 'fallback keeps the persona name');
    t.equal(personaDisplay('pirate').avatarUrl, FALLBACK_AVATAR_SRC, 'unknown persona -> fallback');
    t.equal(personaDisplay.length, 1, 'persona id is the only positional input (no provider/voice)');
    for (const id of Object.keys(BUILTIN_PROFILES)) t.ok(BUILTIN_PROFILES[id].avatar && BUILTIN_PROFILES[id].avatar.name, `${id} has canonical avatar metadata in the persona registry`);
    t.ok(fs.existsSync(path.join(ROOT, 'public', 'personas', 'fallback.svg')), 'fallback asset exists');
    t.ok(fs.existsSync(path.join(ROOT, 'public', 'personas', 'maria.png')), 'maria.png exists');

    // ---- real server ----------------------------------------------------------
    const port = 18990 + Math.floor(Math.random() * 8);
    const server = spawn(process.execPath, ['src/server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(port), DATABASE_URL: 'memory', GEMINI_API_KEY: 'test-placeholder', GROK_API_KEY: 'test-placeholder', ADMIN_TOKEN: '', REALTIME_PROVIDER: 'gemini' },
        stdio: 'ignore',
    });
    const base = `http://127.0.0.1:${port}`;
    const get = async (p) => (await fetch(base + p)).json();
    const publish = async (config) => (await fetch(base + '/api/live-test/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config }) })).json();
    const BASE = { provider: 'gemini', voice: 'Sulafat', persona: 'warm_guide', mood: 'warm', responseLength: 'balanced', tone: 'warm', expertiseLevel: 'balanced', conversationMode: 'friendly', knowledgeMode: 'database_first' };
    try {
        for (let i = 0; i < 40; i += 1) { try { await get('/health'); break; } catch { await sleep(250); } }

        t.ok((await publish(BASE)).ok, 'publish Gemini · Maria');
        let cfg = await get('/api/lite/config');
        t.equal(cfg.persona.display_name, 'Мария', 'next session: Maria');
        t.equal(cfg.persona.avatar_url, '/persona-assets/maria.png', 'next session: Maria avatar');
        t.deepEqual(cfg.persona.display_names, { ru: 'Мария', ro: 'Maria', en: 'Maria' }, 'localized persona names for ro/en UI');
        const mariaAvatar = cfg.persona.avatar_url;

        // an open /lite session on revision "Maria"
        const client = await connect(port, '/realtime?channel=lite');
        const ready = await client.waitFor((e) => e.type === 'session.ready');
        client.sendJson({ type: 'session.start', sampleRate: 16000 });
        await client.waitFor((e) => e.type === 'session.config.applied', { timeoutMs: 8000 });
        await sleep(200);

        t.ok((await publish({ ...BASE, provider: 'grok', voice: 'eve' })).ok, 'publish Grok · Maria');
        cfg = await get('/api/lite/config');
        t.equal(cfg.persona.avatar_url, mariaAvatar, 'Gemini -> Grok within Maria: avatar unchanged');
        t.equal(cfg.persona.display_name, 'Мария', 'Gemini -> Grok within Maria: name unchanged');
        t.ok((await publish({ ...BASE, voice: 'Kore' })).ok, 'publish another Maria voice');
        t.equal((await get('/api/lite/config')).persona.avatar_url, mariaAvatar, 'voice change: avatar unchanged');

        t.ok((await publish({ ...BASE, persona: 'classic', tone: 'formal' })).ok, 'publish Alexander');
        cfg = await get('/api/lite/config');
        t.equal(cfg.persona.display_name, 'Александр', 'next session after persona switch: Alexander');
        t.ok(cfg.persona.avatar_url !== mariaAvatar, 'next session after persona switch: Alexander avatar (or fallback), never Maria');
        const alexanderFile = ['png', 'jpg', 'jpeg', 'webp'].some((e) => fs.existsSync(path.join(ROOT, 'public', 'personas', `alexander.${e}`)));
        t.equal(cfg.persona.avatar_fallback, !alexanderFile, alexanderFile ? 'Alexander asset used' : 'Alexander asset not uploaded yet -> safe fallback');

        const own = await get(`/api/lite/config?session=${ready.session_id}`);
        t.equal(own.persona.source, 'session', 'open session resolves from its own snapshot');
        t.equal(own.persona.display_name, 'Мария', 'open session keeps Maria after the switch');
        t.equal(own.persona.avatar_url, mariaAvatar, 'open session keeps the Maria avatar');
        client.sendCloseFrame(); client.close();

        const assetResponse = await fetch(base + mariaAvatar);
        t.equal(assetResponse.status, 200, 'avatar served');
        t.equal(assetResponse.headers.get('access-control-allow-origin'), '*', 'avatar usable from the partner site');
        t.equal((await fetch(base + '/api/lite/config')).headers.get('access-control-allow-origin'), '*', 'config readable by the widget on the partner site');
        t.equal((await fetch(base + '/persona-assets/fallback.svg')).status, 200, 'fallback served');
        t.equal((await fetch(base + '/persona-assets/..%2Fserver.png')).status, 404, 'no path traversal');
    } finally {
        server.kill();
    }

    // ---- clients use the shared source ----------------------------------------
    const widget = fs.readFileSync(path.join(ROOT, 'public', 'wine-ai-widget.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'dashboard.html'), 'utf8');
    t.ok(!/avatar-woman-1|avatar-man-1|maria\.png|alexander\./.test(widget), 'widget has no hard-coded persona image');
    t.ok(widget.includes('/api/lite/config') && widget.includes('/persona-assets/fallback.svg'), 'widget resolves the persona avatar from the server, fallback on error');
    t.ok(html.includes('function applyLitePersona(persona)') && html.includes("img.src = LITE_FALLBACK_AVATAR"), '/lite applies the persona avatar with a fallback');
    t.ok(html.includes('if (LITE_MODE && liteSessionId) loadLiteConfig(liteSessionId);'), '/lite switches to its session snapshot persona once the session starts');
    t.ok(/object-fit: cover/.test(html) && /object-fit: cover/.test(widget), 'avatars are cropped (cover), never stretched');
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('personaAvatar tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
