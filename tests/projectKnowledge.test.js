'use strict';

// WINE AI Project Knowledge: approved facts about the project itself, routed
// by intent (RU/RO/EN), never from wine retrieval or the web, safe to say to
// anyone. Acceptance set: the founder's interview questions.

const fs = require('fs');
const assert = require('assert');
const pk = require('../src/knowledge/projectKnowledge');
const getProjectInfoTool = require('../src/tools/getProjectInfo');
const { TOOL_DECLARATIONS } = require('../src/tools/index');

const ACCEPTANCE = [
    // [question, allowed topics]
    ['Who are you?', ['identity', 'overview']],
    ['Who created you?', ['creators']],
    ['What is Kando Connect?', ['creators']],
    ['Why was WINE AI created?', ['why']],
    ['How do you work?', ['how_it_works', 'technical']],
    ['Where does your wine information come from?', ['accuracy']],
    ['Can you make mistakes?', ['accuracy']],
    ['What languages do you speak?', ['languages']],
    ['Can I put you on my winery website?', ['business']],
    ['Can you work through QR?', ['business', 'how_it_works']],
    ['What can you show on screen?', ['how_it_works']],
    ['What are your future plans?', ['plans']],
    ['How can I contact the creators?', ['contacts']],
    ['Are you ChatGPT?', ['vs_chatbots']],
    ['Cine ești?', ['identity', 'overview']],
    ['Cine a creat WINE AI?', ['creators']],
    ['De ce a fost creat acest proiect?', ['why']],
    ['Cum funcționează WINE AI?', ['how_it_works']],
    ['De unde obții informațiile despre vinuri?', ['accuracy']],
    ['Prin ce te deosebești de ChatGPT?', ['vs_chatbots']],
    ['Poți vorbi în mai multe limbi?', ['languages']],
    ['Cum poate o vinărie să colaboreze cu voi?', ['business']],
    ['Care este următoarea etapă a proiectului?', ['plans']],
    ['Cum putem lua legătura cu echipa?', ['contacts']],
    ['Кто ты?', ['identity', 'overview']],
    ['Кто тебя создал?', ['creators']],
    ['Что такое Kando Connect?', ['creators']],
    ['Почему создали WINE AI?', ['why']],
    ['Как ты работаешь?', ['how_it_works']],
    ['Откуда ты знаешь о винах?', ['accuracy']],
    ['Ты можешь ошибаться?', ['accuracy']],
    ['На каких языках ты говоришь?', ['languages']],
    ['Можно ли установить тебя на сайте моей винодельни?', ['business']],
    ['Ты работаешь через QR?', ['business', 'how_it_works']],
    ['Что ты можешь показать на экране?', ['how_it_works']],
    ['Какие у проекта планы?', ['plans']],
    ['Как с вами связаться?', ['contacts']],
    ['Ты ChatGPT?', ['vs_chatbots']],
    ['Расскажи о себе', ['identity', 'overview']],
];

const NOT_PROJECT = [
    'Расскажи про винодельню Purcari',
    'Cine a creat vinăria Purcari?',
    'Who founded Cricova?',
    'Какое вино подойдёт к стейку?',
    'Poți vorbi despre Fetească Neagră?',
    'Как работает выдержка в дубе?',
    'What is Fetească Neagră?',
    'Когда основана Cricova?',
    'Где купить Negru de Purcari?',
];

// Things that must never reach a public answer.
const FORBIDDEN = [
    /AIza[0-9A-Za-z_-]{10,}/, /sk-[A-Za-z0-9]{10,}/, /xai-[A-Za-z0-9]{10,}/, /postgres(ql)?:\/\//i, /railway\.(app|internal)/i,
    /password|parol|пароль|jwt|secret|api[\s_-]?key|token/i, /\/dashboard|\/api\/|admin/i,
    /gemini|google|openai|grok|\bxai\b|anthropic|claude|deepgram/i, // model providers are not named
    /wine\s*\.?md/i, // WineMD is not part of the project identity
    /€|\$\s?\d|\d+\s?(eur|usd|lei|mdl)\b/i, // no prices
    /confidential|конфиденц/i,
];

async function run() {
    let n = 0;
    const ok = (cond, msg) => { assert.ok(cond, msg); n += 1; };
    pk._resetCache();
    const raw = fs.readFileSync(pk.DEFAULT_FILE, 'utf8');
    const sections = pk.load();
    for (const topic of pk.TOPICS.filter((t) => t !== 'overview')) {
        ok(sections[topic] && sections[topic].facts.length > 0, `section for ${topic} has facts`);
    }
    const modelFacing = pk.TOPICS.map((t) => JSON.stringify(pk.getProjectInfo(t).facts)).join('\n');
    for (const re of FORBIDDEN) ok(!re.test(modelFacing), `nothing the model receives contains ${re}`);
    for (const re of FORBIDDEN.slice(0, 6)) ok(!re.test(raw), `the document contains no secret matching ${re}`);
    ok(/status: approved/.test(raw) && !/CONFIRM/.test(raw), 'document is the approved version');
    ok(!/\(S\d/.test(JSON.stringify(pk.getProjectInfo('overview'))), 'source codes are not passed to the model');

    // Key approved facts are present where a journalist will ask for them.
    const text = (topic) => JSON.stringify(pk.getProjectInfo(topic));
    ok(/Kando Connect/.test(text('creators')) && /Alexei Ivantov/.test(text('creators')) && /Алексей Иванцов/.test(text('creators')), 'creators: Kando Connect and founder in both spellings');
    ok(/February 2026/.test(text('history')) && /1 October 2026/.test(text('history')) && /National Wine Day/.test(text('history')), 'history: start, beta launch, National Wine Day');
    ok(/\+373 79 676 487/.test(text('contacts')) && /wertikooo@gmail\.com/.test(text('contacts')), 'contacts: phone and email');
    ok(/9 languages/.test(text('languages')), 'languages: 9');
    ok(/\[PLANNED\]/.test(text('plans')) && !/\[NOW\][^"]*kiosk/i.test(text('plans')), 'plans are marked as planned, kiosks never as existing');
    ok(/business/.test(JSON.stringify(pk.getProjectInfo('business').facts.map((f) => f.section).join(' ')).toLowerCase()) && /\+373/.test(text('business')), 'business answer includes contacts');
    ok(/not ChatGPT/.test(text('vs_chatbots')), 'vs chatbots: not ChatGPT');
    ok(pk.getProjectInfo('nonsense').topic === 'overview', 'unknown topic falls back to overview');
    ok(/never present them as working today/.test(pk.ANSWER_INSTRUCTION) && /Never name the AI model providers/.test(pk.ANSWER_INSTRUCTION), 'answer instruction guards plans and providers');

    for (const [question, topics] of ACCEPTANCE) {
        ok(pk.isProjectQuestion(question), `routed to Project Knowledge: ${question}`);
        const topic = pk.topicForQuestion(question);
        ok(topics.includes(topic), `${question} -> ${topic} (expected ${topics.join('|')})`);
    }
    for (const question of NOT_PROJECT) ok(!pk.isProjectQuestion(question), `stays with wine knowledge: ${question}`);

    // The tool and the guards in the other search tools.
    ok(TOOL_DECLARATIONS.some((d) => d.name === 'get_project_info'), 'get_project_info is declared to the model');
    const viaTool = await getProjectInfoTool.impl({ question: 'Cine a creat WINE AI?' });
    ok(viaTool.topic === 'creators' && viaTool.source === 'wine_ai_project_knowledge', 'tool picks the topic from the question');
    const { impl: searchKnowledge } = require('../src/tools/searchLayeredKnowledge');
    const guarded = await searchKnowledge({ query: 'Кто тебя создал?' }, {});
    ok(guarded.source === 'wine_ai_project_knowledge' && guarded.topic === 'creators', 'search_wine_knowledge answers a project question from Project Knowledge');
    const { impl: searchWebImpl } = require('../src/tools/searchWeb');
    const webGuarded = await searchWebImpl({ query: 'WINE AI Kando Connect founder' });
    ok(webGuarded.source === 'wine_ai_project_knowledge', 'search_web never goes online for WINE AI itself');
    return { assertionCount: n };
}

module.exports = { run };

if (require.main === module) {
    run().then((r) => { console.log(`projectKnowledge passed (${r.assertionCount})`); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
