'use strict';

// Visual Companion, part 1 (Wine AI Lite): transcript + text input.
// Presentation only: the transcript is rendered with textContent (model
// text never becomes HTML or a clickable link), the linkifying reply box is
// hidden on /lite, typed questions use the existing input_text.submit path,
// and VISUAL_COMPANION_ENABLED=false turns the whole layer off.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

function extractFunction(source, name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    let depth = 0;
    for (let i = source.indexOf('{', start); i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1); }
    }
    throw new Error(`unterminated ${name}`);
}

async function run() {
    let n = 0;
    const ok = (v, m) => { n += 1; assert.ok(v, m); };
    const root = path.join(__dirname, '..');
    const html = fs.readFileSync(path.join(root, 'public', 'dashboard.html'), 'utf8');
    const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');

    const append = extractFunction(html, 'liteChatAppend');
    ok(append.includes('textContent'), 'transcript text is written with textContent');
    ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(append), 'transcript never writes HTML');
    ok(!/linkify|<a |createElement\('a'\)/.test(append), 'transcript never creates links from model text');
    ok(/try\s*{[\s\S]*}\s*catch/.test(append), 'transcript rendering cannot throw into the realtime handler');
    ok(/body\.lite[^{]*#replyBox[^{]*{\s*display:\s*none/.test(html) || /#replyBox\s*{\s*display:\s*none\s*!important/.test(html.slice(html.indexOf('body.lite #demoWinePicker'), html.indexOf('body.lite #demoWinePicker') + 300)), 'the linkifying reply box is hidden on /lite');

    ok(html.includes("if (LITE_MODE) liteChatAppend('user', payload);"), 'user transcript feeds the lite chat');
    ok(html.includes("if (LITE_MODE) liteChatAppend('assistant', payload);"), 'assistant transcript feeds the lite chat');
    ok(extractFunction(html, 'sendTextTurn').includes("type: 'input_text.submit'"), 'typed questions use the existing input_text.submit conversation path');
    ok(/body\.lite\.vc \.app-input-row\s*{\s*display:\s*flex !important/.test(html), 'text input is shown on /lite only when the companion is on');

    ok(server.includes("pathname === '/api/lite/config'") && server.includes("process.env.VISUAL_COMPANION_ENABLED !== 'false'"), 'VISUAL_COMPANION_ENABLED flag served to /lite (default on)');
    const loader = extractFunction(html, 'loadLiteConfig');
    ok(loader.includes("classList.toggle('vc'") && loader.includes('catch'), 'flag off or config failure leaves the voice-only page');

    // Behaviour check of the extracted renderer against a tiny fake DOM.
    const nodes = [];
    function el(tag) {
        const node = { tag, className: '', textContent: '', children: [], appendChild(c) { this.children.push(c); return c; }, querySelector(sel) { return this.children.find((c) => sel === '.' + c.className) || null; }, scrollTop: 0, scrollHeight: 0 };
        nodes.push(node);
        return node;
    }
    const box = el('div');
    const fakeDocument = {
        body: { classList: { contains: (c) => c === 'vc' }, dataset: { personaName: 'Мария' } },
        getElementById: (id) => (id === 'liteChat' ? box : null),
        createElement: el,
    };
    // eslint-disable-next-line no-new-func
    const companionCalls = [];
    const factory = new Function('document', 'uiLang', 'liteChatBubbles', 'liteCompanionOnText', `${extractFunction(html, 'liteAssistantName')}\n${append}\nreturn liteChatAppend;`);
    const render = factory(fakeDocument, 'ru', new Map(), (key, text) => companionCalls.push([key, text]));
    render('user', { turn_id: 't1', text: 'Где купить? ' });
    render('user', { turn_id: 't1', text: '<img src=x onerror=alert(1)> javascript:alert(1)' });
    render('assistant', { generation_id: 'g1', text: 'Смотрите https://evil.example/x ' });
    render('assistant', { generation_id: 'g1', text: 'и всё.' });
    ok(box.children.length === 2, 'fragments merge into one bubble per turn / generation');
    const [userBubble, modelBubble] = box.children;
    ok(userBubble.children[0].textContent === 'Вы' && modelBubble.children[0].textContent === 'Мария', 'speaker labels: Вы / persona name');
    ok(userBubble.children[1].textContent.includes('<img src=x'), 'markup stays literal text');
    ok(modelBubble.children[1].textContent === 'Смотрите https://evil.example/x и всё.', 'model URL stays plain text');
    ok(!nodes.some((node) => node.tag === 'a'), 'no anchor element is ever created');
    ok(companionCalls.length === 2 && companionCalls[1][1] === 'Смотрите https://evil.example/x и всё.', 'assistant text (full, per generation) is handed to the card companion');
    render('assistant', null);
    render('assistant', { generation_id: 'g2' });
    ok(box.children.length === 2, 'empty/invalid payloads are ignored without throwing');
    return { assertionCount: n };
}

module.exports = { run };

if (require.main === module) {
    run().then((r) => { console.log(`liteCompanionTranscript passed (${r.assertionCount})`); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
