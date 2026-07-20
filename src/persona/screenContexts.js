'use strict';

// Screen-launch contexts for the "Ask Wine AI about this winery/wine"
// buttons — see docs task "демо винодельни и вина с контекстным Wine AI".
// Deliberately NOT a second voice module: this only builds text that flows
// through the *existing* session.start `config.persona` override (already
// present in realtimePrompt.js/realtimeServer.js, gated by
// DASHBOARD_ALLOW_CUSTOM_PROMPT) — the realtime transport, mic pipeline,
// and provider code are completely untouched.
const { defaultPersonaPrompt } = require('./wineExpertPersona');

const WINERY = {
    id: 'crama-dealul-de-aur',
    type: 'winery',
    name: 'Crama Dealul de Aur',
    openingLine: 'Вы сейчас смотрите Crama Dealul de Aur. Можно спросить меня об истории винодельни, её винах, сортах винограда, экскурсиях или выбрать бутылку для дегустации.',
    suggestedPrompts: [
        'Расскажи историю винодельни',
        'Какие вина здесь производят?',
        'Что попробовать первым?',
        'Как записаться на дегустацию?',
    ],
};

const WINE = {
    id: 'dealul-de-aur-feteasca-neagra-reserve-2019',
    type: 'wine',
    name: 'Dealul de Aur Fetească Neagră Reserve 2019',
    wineryId: WINERY.id,
    openingLine: 'Вы смотрите Dealul de Aur Fetească Neagră Reserve 2019. Можно спросить меня о вкусе, подаче, декантации, выдержке, гастрономических сочетаниях или о том, стоит ли открывать бутылку сейчас.',
    suggestedPrompts: [
        'Опиши вкус простыми словами',
        'С чем его подать?',
        'Нужно ли декантировать?',
        'Можно ли хранить дальше?',
    ],
};

const CONTEXTS = { winery: WINERY, wine: WINE };

function getScreenContext(type, id) {
    const ctx = CONTEXTS[type];
    if (!ctx || ctx.id !== id) return null;
    return ctx;
}

// Appends a context block to the real default persona (never replaces it —
// every safety/style rule in CORE_PERSONA_PROMPT, or the dashboard-edited
// override, still applies). The model is instructed to open with the exact
// scripted line ONLY on the session's first turn, then continue freely —
// this is what makes it "not a single hardcoded reply" per the task's
// explicit requirement.
function buildContextualPersona(ctx) {
    const base = defaultPersonaPrompt();
    const subjectLine = ctx.type === 'winery'
        ? `Пользователь сейчас открыл экран винодельни "${ctx.name}" в приложении. Это демонстрационная вымышленная винодельня — используй сведения о ней из базы знаний.`
        : `Пользователь сейчас открыл экран вина "${ctx.name}" (винодельня Crama Dealul de Aur). Это демонстрационное вымышленное вино — используй сведения о нём из базы знаний.`;
    const block = [
        '',
        '[КОНТЕКСТ ЭКРАНА]',
        subjectLine,
        `В самом первом своём ответе в этой сессии — даже если реплика пользователя короткая или общая — начни ровно с этой фразы: "${ctx.openingLine}". После этого веди диалог свободно: отвечай на реальные вопросы пользователя, используй базу знаний, не повторяй эту фразу снова в течение разговора.`,
        'Ты можешь отвечать и на общие вопросы о молдавском вине, но по умолчанию считай, что разговор в первую очередь про открытый объект, пока пользователь явно не сменит тему. Если пользователь спрашивает о факте, которого нет в демонстрационных данных, честно скажи, что точной информации об этом нет, вместо того чтобы придумывать.',
    ].join('\n');
    return `${base}\n${block}`;
}

module.exports = { WINERY, WINE, CONTEXTS, getScreenContext, buildContextualPersona };
