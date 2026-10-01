'use strict';

// Production 30 Sep: the 30-second warning is sent to the model as a text
// turn prefixed "[system instruction, speak this exact sentence ...]"; the
// server echoes text turns back as transcript.user, and the /lite chat showed
// that technical line as a guest message. The echo must never be rendered.

const fs = require('fs');
const path = require('path');
const t = require('./helpers/assertions');

async function run() {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
    const fn = html.match(/function isScriptedLineEcho\(text\) \{[\s\S]*?\n  \}/);
    t.ok(fn, 'isScriptedLineEcho defined');
    const prefix = (html.match(/const SCRIPTED_LINE_PREFIX = '([^']+)'/) || [])[1];
    t.ok(prefix && prefix.startsWith('[system instruction'), 'prefix is a named constant');
    // eslint-disable-next-line no-new-func
    const isEcho = new Function(`${fn[0]}; return isScriptedLineEcho;`)();
    t.equal(isEcho(`${prefix} У нас осталось полминуты. Давайте успеем разобрать последний вопрос.`), true, 'warning echo detected');
    t.equal(isEcho('  [system instruction, speak this exact sentence verbatim and nothing else] Спасибо!'), true, 'leading spaces tolerated');
    t.equal(isEcho('Расскажи про Пуркарь'), false, 'a real guest message is shown');
    t.equal(isEcho(undefined), false);
    // Start-intent card starter (StartIntentLauncher.buildStartIntentStarter).
    t.equal(isEcho('Conversation start context:\nПомоги пользователю подобрать вино.\nYour first spoken reply must be exactly this sentence'), true, 'start-card starter echo hidden');
    t.equal(isEcho('Conversation about wine'), false, 'ordinary English question still shown');

    const handler = html.match(/case 'transcript\.user':([\s\S]*?)case 'transcript\.model'/);
    t.ok(handler, 'transcript.user handler found');
    const body = handler[1];
    t.ok(body.indexOf('isScriptedLineEcho(payload.text)') >= 0, 'handler filters the echo');
    t.ok(body.indexOf('isScriptedLineEcho(payload.text)') < body.indexOf('liteChatAppend'), 'filtered before the Lite chat renders it');
    t.ok(body.indexOf('isScriptedLineEcho(payload.text)') < body.indexOf('addTranscriptTurn'), 'filtered before the transcript renders it');
    t.ok(/text: `\$\{SCRIPTED_LINE_PREFIX\} \$\{localizeScriptedLine\(text\)\}`/.test(html), 'speakScriptedLine uses the same prefix');
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('scriptedLineEcho tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
