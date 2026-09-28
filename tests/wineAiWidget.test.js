'use strict';

// WineMD website widget shell: the loader only opens the existing Wine AI
// Lite (/lite?embed=1) in an isolated panel, and the signed age token lets
// the embedded (cross-site) page keep adult verification without cookies.

const fs = require('fs');
const path = require('path');
const t = require('./helpers/assertions');
const age = require('../src/security/ageVerification');

async function run() {
    const root = path.join(__dirname, '..');
    const widget = fs.readFileSync(path.join(root, 'public', 'wine-ai-widget.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'public', 'dashboard.html'), 'utf8');
    const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');

    // Loader: shell only.
    t.ok(widget.includes("attachShadow({ mode: 'open' })"), 'launcher and styles isolated in a Shadow DOM');
    t.ok(widget.includes(':host { all: initial; }'), 'host page CSS does not leak into the launcher');
    t.ok(widget.includes('`${origin}/lite?embed=1&lang=${lang}`'), 'panel loads the same Wine AI Lite (/lite?embed=1) in the widget language');
    t.ok(/pageLang\) \? pageLang : 'en'\)/.test(widget), 'default language: page lang, else English (never Russian by default)');
    t.ok(widget.includes("iframe.allow = 'microphone; autoplay'"), 'iframe may use the microphone');
    t.ok(widget.includes('event.origin !== origin') && widget.includes('event.source !== iframe.contentWindow'), 'close messages accepted only from the Wine AI iframe');
    t.ok(widget.includes("postMessage({ type: 'wine-ai:stop' }, origin)"), 'closing stops the conversation (mic released)');
    t.ok(!/getUserMedia|WebSocket|AudioContext|example\.com|hold.?to.?talk/i.test(widget), 'no conversation/voice logic, demo links or Hold-to-Talk in the loader');
    t.ok(server.includes("pathname === '/wine-ai-widget.js'"), 'loader served at /wine-ai-widget.js');

    // Lite embed mode.
    t.ok(html.includes("new URLSearchParams(location.search).get('embed') === '1' && window.parent !== window"), 'embed mode only inside an iframe');
    t.ok(html.includes("event.source !== window.parent || !event.data || event.data.type !== 'wine-ai:stop'"), 'stop accepted only from the parent window');
    t.ok(html.includes("{ ru: 'Поговорить с сомелье', ro: 'Vorbește cu somelierul', en: 'Talk to the sommelier' }"), 'one start button: Поговорить с сомелье');
    t.ok(html.includes('🌐 AUTO'), 'AUTO language indicator');
    t.ok(html.includes("['ru', 'ro', 'en'].includes(LITE_URL_LANG)") && html.includes("|| 'en') : 'en'));"), 'Lite UI language: ?lang=, else browser, else English');
    for (const l of ['ru', 'ro', 'en']) t.ok(new RegExp(`\\b${l}: \\{ ageTitle:`).test(html), `age gate + rating localized (${l})`);

    // Living avatar (presentation only).
    t.ok(html.includes('@keyframes liteBreath') && html.includes('@keyframes liteThink'), 'idle breathing and thinking tilt animations');
    t.ok(html.includes("box.classList.toggle('thinking', state === 'thinking');"), 'thinking state exposed to CSS');
    t.ok(/function liteAvatarMotion[\s\S]*getByteTimeDomainData[\s\S]*--lite-amp/.test(html), 'speaking bounce reads the existing output analyser');
    t.ok(!/function liteAvatarMotion[\s\S]{0,1600}(createAnalyser|\.connect\()/.test(html), 'avatar motion never creates or connects audio nodes');
    t.ok(/prefers-reduced-motion: reduce\)[\s\S]{0,200}body\.lite \.avatar-box \.avatar-fallback \{ animation: none !important/.test(html), 'reduced motion respected');

    // Age token: same signature as the cookie, for cross-site iframes.
    const token = age.issueAdultToken();
    t.ok(age.isAdultTokenValid(token), 'issued token is valid');
    t.ok(!age.isAdultTokenValid(token.slice(0, -2) + 'xx'), 'tampered token rejected');
    t.ok(!age.isAdultTokenValid(''), 'empty token rejected');
    const expiredPayload = Buffer.from(JSON.stringify({ v: 1, verifiedAt: 1, expiresAt: 2 })).toString('base64url');
    t.ok(!age.isAdultTokenValid(age.issueAdultToken({ now: 1 }), { now: Date.now() }), 'expired token rejected');
    t.ok(expiredPayload.length > 0, 'payload built');
    t.ok(age.issueAdultCookie({ token }).includes(encodeURIComponent(token)), 'cookie and token carry the same signed value');
    t.ok(server.includes("isAdultTokenValid(req.headers['x-adult-token'])"), 'status check accepts the token header');
    t.ok(server.includes("searchParams.get('av')"), 'realtime upgrade accepts the token (cookie still accepted)');
    t.ok(html.includes("&av=${encodeURIComponent(adultToken)}"), 'Lite passes the token on its realtime socket');
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('wineAiWidget tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
