'use strict';

// WINE AI Project Knowledge: the one authoritative, public source of facts
// about WINE AI itself (identity, creators, history, how it works, plans,
// contacts) -- knowledge/project/WINE_AI_PROJECT.md, approved by the founder.
//
// Code only ROUTES: it recognizes a question about the project and picks the
// topic. Every fact the assistant speaks comes from the document, never from
// this file. The document is kept out of the wine RAG (the loader reads only
// knowledge/source), so project facts never compete with wine documents and
// no question about WINE AI itself goes to the open web.

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.resolve(__dirname, '..', '..', 'knowledge', 'project', 'WINE_AI_PROJECT.md');

// Section number in the document -> topic id.
const SECTION_TOPICS = Object.freeze({
    1: 'identity',
    2: 'why',
    3: 'why_moldova',
    4: 'vs_chatbots',
    5: 'creators',
    6: 'history',
    7: 'how_it_works',
    8: 'technical',
    9: 'languages',
    10: 'accuracy',
    11: 'use_cases',
    12: 'business',
    13: 'plans',
    14: 'contacts',
});

const TOPICS = Object.freeze(['overview', ...Object.values(SECTION_TOPICS)]);

// Topics returned together: an "overview" answers "tell me about yourself";
// some topics always need a neighbour (business -> contacts).
const TOPIC_BUNDLES = Object.freeze({
    overview: ['identity', 'creators', 'history', 'how_it_works'],
    identity: ['identity', 'creators'],
    creators: ['creators', 'history'],
    business: ['business', 'contacts'],
    plans: ['plans', 'history'],
    contacts: ['contacts'],
});

const ANSWER_INSTRUCTION = 'These are the authoritative, approved facts about WINE AI. Answer ONLY from them, in the language the user is speaking, as natural spoken words -- never read the list or the section names aloud. A simple question gets 1-3 sentences; "tell me more" or a journalist\'s question gets a complete, natural spoken answer. Items marked [PLANNED] are plans: say "we plan" / "in the future", never present them as working today; [BETA] means available in an early form. Introduce yourself with your own character name (Maria or Alexander) as WINE AI\'s digital sommelier; the facts are the same for both. Never name the AI model providers, never add facts that are not here, and never search the internet for facts about WINE AI. Say phone numbers in digit groups and never read a web address aloud.';

let cache = null;

function stripSources(line) {
    return line.replace(/\s*\((S\d+(?:,\s*S\d+)*)\)\s*$/, '').trim();
}

function parseDocument(text) {
    const body = String(text).replace(/^---[\s\S]*?\n---\n/, '');
    const sections = {};
    let current = null;
    for (const raw of body.split('\n')) {
        const heading = raw.match(/^##\s+(\d+)\.\s+(.+)$/);
        if (heading) {
            const topic = SECTION_TOPICS[Number(heading[1])];
            current = topic ? { topic, title: heading[2].trim(), facts: [] } : null;
            if (current) sections[topic] = current;
            continue;
        }
        if (/^##\s+/.test(raw)) { current = null; continue; }
        if (!current) continue;
        const line = raw.trim();
        if (line.startsWith('- ')) current.facts.push(stripSources(line.slice(2)));
    }
    return sections;
}

function load(file = DEFAULT_FILE) {
    if (cache && cache.file === file) return cache.sections;
    const sections = parseDocument(fs.readFileSync(file, 'utf8'));
    cache = { file, sections };
    return sections;
}

function getProjectInfo(topic, { file } = {}) {
    const sections = load(file);
    const id = TOPICS.includes(topic) ? topic : 'overview';
    const ids = TOPIC_BUNDLES[id] || [id];
    return {
        found: true,
        source: 'wine_ai_project_knowledge',
        topic: id,
        facts: ids.filter((t) => sections[t]).map((t) => ({ section: sections[t].title, items: sections[t].facts })),
        instruction: ANSWER_INSTRUCTION,
    };
}

// ---- Routing ---------------------------------------------------------------
// A question is about the project when it names WINE AI / Kando Connect or the
// founder, or addresses the assistant itself ("who are you", "who made you",
// "how do you work"). A question about a winery's creator is NOT.

function fold(text) {
    return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ё/g, 'е');
}

const NAMES_RE = /\b(wine\s*ai|wineai|kando|ivantov|ivantsov)\b|иванцов|вайн\s*(эй\s*ай|аи)|вин\s*аи/;
// Second-person self-reference: the question is about the assistant itself.
const SELF_RE = new RegExp([
    // RU
    'кто\\s+ты', 'ты\\s+кто', 'кто\\s+вы([\\s?!.,]|$)', 'расскажи\\s+(немного\\s+)?о\\s+себе', 'о\\s+себе',
    'кто\\s+(тебя|вас)\\s+(создал|сделал|разработал|придумал|запрограммировал)', '(тебя|вас)\\s+(создал|сделал|разработал)',
    'как\\s+ты\\s+(работаешь|устроен|устроена|знаешь)', 'откуда\\s+ты\\s+(знаешь|берешь)', 'зачем\\s+(тебя|вас)\\s+(создали|сделали)', 'почему\\s+(тебя|вас)\\s+(создали|сделали)',
    'ты\\s+(chatgpt|чатgpt|чат\\s*гпт|робот|человек|бот|ии|искусственный)', 'на\\s+каких\\s+языках\\s+ты', 'ты\\s+(ошибаешься|можешь\\s+ошибаться)',
    '(твои|ваши)\\s+планы', 'как\\s+с\\s+(вами|тобой)\\s+связаться', '(установить|поставить)\\s+(тебя|вас)', 'ты\\s+работаешь\\s+через', 'что\\s+ты\\s+(умеешь|можешь\\s+показать)',
    // RO (diacritics folded)
    'cine\\s+(esti|sunteti)', 'cine\\s+te-?a\\s+(creat|facut)', 'cine\\s+v-?a\\s+creat', 'despre\\s+tine', 'cum\\s+functionezi', 'de\\s+unde\\s+(stii|obtii|iei)',
    'prin\\s+ce\\s+te\\s+deosebesti', 'poti\\s+vorbi\\s+(in|mai\\s+multe|si\\s+in)', 'vorbesti\\s+(in|limba|mai\\s+multe|si)', 'ce\\s+limbi\\s+vorbesti', 'colabor\\w*\\s+cu\\s+voi', 'luam\\s+legatura', 'legatura\\s+cu\\s+(echipa|voi)', 'te\\s+pot\\s+(instala|pune)',
    // EN
    'who\\s+are\\s+you', 'who\\s+(created|made|built|developed)\\s+you', 'about\\s+yourself', 'how\\s+do\\s+you\\s+work', 'where\\s+does\\s+your', 'are\\s+you\\s+(chatgpt|a\\s+bot|human|an\\s+ai)',
    'can\\s+you\\s+make\\s+mistakes', 'what\\s+languages\\s+do\\s+you', 'put\\s+you\\s+on', 'can\\s+you\\s+work\\s+through', 'what\\s+can\\s+you\\s+show', 'your\\s+(future\\s+)?plans', 'contact\\s+(the\\s+)?(creators|team|you)',
    'why\\s+were\\s+you', 'why\\s+was\\s+(wine\\s*ai|this\\s+project)',
].join('|'));
const PROJECT_WORD_RE = /\b(proiect\w*|project)\b|проект\w*/;

function isProjectQuestion(query) {
    const q = fold(query);
    if (!q.trim()) return false;
    if (NAMES_RE.test(q)) return true;
    if (SELF_RE.test(q)) return true;
    // "Care este următoarea etapă a proiectului?" / "Какие у проекта планы?"
    return PROJECT_WORD_RE.test(q) && /(etapa|plan|планы|этап|next\s+step|stage|creat|de\s+ce|scop|создан|созда|зачем|почему|цель|why|purpose)/.test(q);
}

const TOPIC_RULES = [
    ['contacts', /(связат|контакт|телефон|contact|legatura|telefon|email|почт)/],
    ['business', /(сайт\w*\s+(моей|нашей)|винодельн\w*\s+сотруднич|сотруднич|установить|поставить|colabor|site-?ul|website|on\s+my|put\s+you|vinari[ea]\s+sa|партн|partner|b2b|qr)/],
    ['plans', /(план|будущ|следующ|этап|plan|viitor|urmatoar|etapa|future|next)/],
    ['why', /(зачем|почему|de\s+ce|why)/],
    ['creators', /(созда|сделал|разработ|основател|kando|ivantov|иванцов|creat|facut|founder|made|built|developed)/],
    ['vs_chatbots', /(chatgpt|чат\s*гпт|чатgpt|отлича|deosebest|different|differ)/],
    ['languages', /(язык|limb|language|vorbi|speak)/],
    ['accuracy', /(ошиба|откуда|источник|информаци|gresi|unde\s+obtii|de\s+unde|mistake|where\s+does\s+your|information\s+come)/],
    ['technical', /(технически|technical|tehnic)/],
    ['how_it_works', /(как\s+ты\s+работаешь|как\s+работает|functioneaz|functionezi|how\s+do\s+you\s+work|how\s+does|показать|show|экран|screen)/],
    ['history', /(когда|история|запуск|начал|cand|istori|lansa|when|history|launch)/],
    ['identity', /(кто\s+ты|ты\s+кто|о\s+себе|cine\s+esti|despre\s+tine|who\s+are\s+you|yourself|что\s+такое|ce\s+este|what\s+is)/],
];

function topicForQuestion(query) {
    const q = fold(query);
    for (const [topic, re] of TOPIC_RULES) if (re.test(q)) return topic;
    return 'overview';
}

module.exports = {
    DEFAULT_FILE,
    TOPICS,
    ANSWER_INSTRUCTION,
    parseDocument,
    load,
    getProjectInfo,
    isProjectQuestion,
    topicForQuestion,
    _resetCache: () => { cache = null; },
};
