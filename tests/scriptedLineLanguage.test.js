'use strict';

// Production 1 Oct: the conversation switched to English, but the session-end
// line ("Мне пора немного отдохнуть...") was still spoken in Russian. Service
// lines must follow the language of the last guest/assistant line.

const fs = require('fs');
const path = require('path');
const t = require('./helpers/assertions');

async function run() {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
    const constants = html.match(/  const FREE_CONV_INACTIVITY_WARNING_TEXT[^\n]*\n  const FREE_CONV_INACTIVITY_GOODBYE_TEXT[^\n]*\n/)[0]
        + html.match(/  const FREE_CONV_SESSION_WARNING_TEXT[^\n]*\n  const FREE_CONV_SESSION_LIMIT_TEXT[^\n]*\n/)[0];
    const block = html.match(/  const SCRIPTED_LINE_TRANSLATIONS = \{[\s\S]*?\n  function localizeScriptedLine\(text\) \{[\s\S]*?\n  \}/);
    t.ok(block, 'translations + detector + localizer found');
    // eslint-disable-next-line no-new-func
    const api = new Function('uiLang', 'LITE_MODE', `${constants}${block[0]}; return { noteConversationLang, localizeScriptedLine, reset: () => { conversationLang = null; conversationLangText.clear(); }, FREE_CONV_SESSION_LIMIT_TEXT, FREE_CONV_SESSION_WARNING_TEXT, FREE_CONV_INACTIVITY_WARNING_TEXT, FREE_CONV_INACTIVITY_GOODBYE_TEXT };`)('ru', true);

    const end = api.FREE_CONV_SESSION_LIMIT_TEXT;
    t.equal(api.localizeScriptedLine(end), end, 'no conversation yet: page language (ru)');

    api.noteConversationLang('user', 't1', 'Расскажи про Пуркарь');
    t.equal(api.localizeScriptedLine(end), end, 'Russian conversation: Russian line');

    // Switch to English mid-conversation; assistant transcript arrives in fragments.
    api.noteConversationLang('user', 't2', 'Tell me about Cricova please');
    api.noteConversationLang('assistant', 't2', 'Cricova is famous ');
    api.noteConversationLang('assistant', 't2', 'for its underground cellars.');
    t.ok(/rest/.test(api.localizeScriptedLine(end)), 'English conversation: English session-end line');
    t.ok(/half a minute/.test(api.localizeScriptedLine(api.FREE_CONV_SESSION_WARNING_TEXT)), 'English 30-second warning');

    api.noteConversationLang('user', 't3', 'Ce vin îmi recomanzi?');
    t.ok(/odihnesc/.test(api.localizeScriptedLine(end)), 'Romanian conversation: Romanian line');
    t.ok(/Mai sunteți aici/.test(api.localizeScriptedLine(api.FREE_CONV_INACTIVITY_WARNING_TEXT)), 'Romanian inactivity check-in');

    api.noteConversationLang('user', 't4', 'ok');
    t.ok(/odihnesc/.test(api.localizeScriptedLine(end)), 'too short to tell: keeps the last language');

    api.reset();
    t.equal(api.localizeScriptedLine(api.FREE_CONV_INACTIVITY_GOODBYE_TEXT), api.FREE_CONV_INACTIVITY_GOODBYE_TEXT, 'new conversation: back to the page language');
    t.equal(api.localizeScriptedLine('some other text'), 'some other text', 'unknown line passes through');

    // Wiring: both transcripts feed the detector after the echo filter, the
    // spoken line is localized, and a finished conversation resets it.
    const user = html.match(/case 'transcript\.user':([\s\S]*?)case 'transcript\.model'/)[1];
    t.ok(user.indexOf('isScriptedLineEcho(payload.text)') < user.indexOf('noteConversationLang('), 'scripted echo never changes the language');
    t.ok(/case 'transcript\.model':[\s\S]{0,400}noteConversationLang\('assistant'/.test(html), 'assistant transcript feeds the detector');
    t.ok(html.includes('`${SCRIPTED_LINE_PREFIX} ${localizeScriptedLine(text)}`'), 'spoken line is localized');
    t.ok(/function finishLiteConversation\(\) \{[\s\S]{0,200}conversationLang = null;/.test(html), 'reset when a Lite conversation ends');
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('scriptedLineLanguage tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
