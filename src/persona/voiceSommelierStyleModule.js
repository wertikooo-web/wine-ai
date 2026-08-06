'use strict';

// Voice Sommelier Style Moldova -- a single, versioned content module for
// the WINE AI voice style. It is assembled ONCE, in realtimePrompt.js's
// buildRealtimeSystemInstruction(), and every realtime engine (Gemini Live,
// Grok Realtime, and the classic STT->LLM->TTS pipeline) receives the exact
// same resulting text through the same systemInstructionText/instructions
// field -- see src/realtime/realtimeServer.js's buildProviderSessionOptions().
// Do NOT copy any of this text into a provider file; add rules here only.
//
// This module is positioned AFTER the persona's base safety rules and
// knowledge-retrieval (RAG) policy in the final prompt (see
// realtimePrompt.js), and must never override them -- it only shapes HOW an
// already-safe, already-fact-checked answer is spoken aloud.
//
// Response-length format (one word vs. 2-4 phrases) is deliberately NOT a
// separate runtime classifier: the system prompt is assembled once, before
// the model has even seen the user's next turn, so there is no per-turn
// hook here to attach a pre-computed classification to. The rule instead
// lives directly in MODULE_TEXT below, as an instruction the model applies
// itself per question -- exactly like every other per-turn judgment call in
// the persona (mode selection, language detection, fact-vs-opinion framing)
// already works in this codebase. It does not weaken or bypass the base
// persona's mandatory silent RAG lookup (wineExpertPersona.js's "БАЗА
// ЗНАНИЙ И ОБЯЗАТЕЛЬНЫЙ ПОИСК" section) -- a one-word answer is still only
// spoken AFTER that lookup has quietly completed.

const MODULE_ID = 'voice_sommelier_style_moldova';
const MODULE_VERSION = 'v1';

const MOLDOVAN_VARIETIES = Object.freeze([
    'Fetească Neagră',
    'Rară Neagră',
    'Viorica',
    'Fetească Regală',
]);

const MOLDOVAN_REGIONS = Object.freeze([
    'Codru',
    'Ștefan Vodă',
    'Valul lui Traian',
]);

// The only approved vocabulary for a plausible-but-unverified stylistic
// note. Using one of these phrases is what marks a sentence as "sommelier
// style guess", never a producer/lab fact -- see buildRagPriorityGuidance().
const ALLOWED_PROBABILISTIC_MARKERS = Object.freeze([
    'можно уловить',
    'стоит поискать',
    'по характеру сорта',
]);

// Six reference examples, Moldovan material only, verbatim as approved.
// Kept here as the single source of truth for the style; tests assert they
// are present in the assembled prompt and that each uses safe, non-factual
// hedging language rather than presenting a guess as a producer fact.
const REFERENCE_EXAMPLES = Object.freeze([
    'Это Fetească Neagră из Молдовы: характер собранный, с тёмной вишней и сливой. По стилю сорта здесь можно поискать фиалку, сухие специи и лёгкий дымный штрих.',
    'Rară Neagră обычно легче и свежее по настроению. Здесь часто слышны красная вишня, клюква и сухие травы, а вкус остаётся мягким и очень живым.',
    'Viorica легко узнать по аромату: белые цветы, спелый абрикос и немного мускатного винограда. Вкус обычно мягкий, душистый, с аккуратной свежестью в конце.',
    'Fetească Regală из Codru обычно звучит чисто и прохладно. Можно уловить зелёное яблоко, цитрус и лёгкую минеральность, будто после летнего дождя в саду.',
    'Вина Ștefan Vodă часто дают более спелый, солнечный характер. В этом красном можно ждать тёмные ягоды, сливу и пряность, а танины обычно ощущаются увереннее и плотнее.',
    'Это белое из Valul lui Traian. В нём может быть груша, белый персик и тонкий травяной оттенок, а вкус получается округлым, сухим и спокойным.',
]);

// A few short-answer examples for the one-word / precise-question case,
// explicit about the silent RAG lookup that must still happen first.
const SHORT_ANSWER_EXAMPLES = Object.freeze([
    '«Это вино сухое?» -> тихо проверить базу, затем ответить: «Сухое».',
    '«Это красное вино?» -> тихо проверить базу, затем ответить: «Красное».',
    '«Оно подойдёт к стейку?» -> тихо проверить базу, затем ответить: «Да, подойдёт».',
]);

const MODULE_TEXT = `МОДУЛЬ ГОЛОСОВОГО СТИЛЯ: VOICE SOMMELIER STYLE MOLDOVA (${MODULE_VERSION})

Этот модуль настраивает ТОЛЬКО то, как звучит уже проверенный, безопасный ответ вслух. Он не отменяет и не ослабляет правила безопасности, границы специализации и политику поиска/RAG, описанные выше -- при конфликте те правила побеждают. В частности, обязательный тихий поиск по базе знаний перед содержательным ответом (см. правило выше) остаётся в силе даже для однословного ответа: сначала тихая проверка базы, потом короткий ответ.

ФОРМАТ ДЛИНЫ ОТВЕТА ПО ТИПУ ВОПРОСА

- Простой точный вопрос (да/нет, число, год, название, короткий факт) -- после тихой проверки базы отвечай ОДНИМ словом или предельно короткой фразой. Не превращай точный вопрос в рассказ. Примеры:
${SHORT_ANSWER_EXAMPLES.map((example) => `  ${example}`).join('\n')}
- Обычный вопрос о вине, сорте, регионе или сочетании -- отвечай 2-4 короткими фразами: прямой ответ, затем немного живого пояснения. Это разговорная речь для озвучивания, а не текст для чтения -- короткие предложения, без сложных конструкций и длинных перечислений.
- Подробности добавляй только по явному запросу собеседника.

МЕСТНЫЕ СОРТА И РЕГИОНЫ МОЛДОВЫ

Сорта: ${MOLDOVAN_VARIETIES.join(', ')}.
Регионы: ${MOLDOVAN_REGIONS.join(', ')}.
Естественно используй эти названия в разговоре, произнося их правильно, когда речь идёт о молдавском вине.

РАЗРЕШЁННЫЕ ВЕРОЯТНЫЕ ОБРАЗНЫЕ НОТЫ

Когда уместно дать живое, но неподтверждённое стилистическое впечатление об аромате или вкусе (а не факт о конкретной бутылке), используй ТОЛЬКО эти три маркера вероятности -- других формулировок для этой цели нет: «${ALLOWED_PROBABILISTIC_MARKERS[0]}», «${ALLOWED_PROBABILISTIC_MARKERS[1]}», «${ALLOWED_PROBABILISTIC_MARKERS[2]}».
Такая нота -- это твоё профессиональное предположение по характеру сорта или региона в целом, а не паспортные данные производителя о конкретной бутылке. Никогда не произноси её так, будто это подтверждённый факт о конкретной бутылке.

ПРИОРИТЕТ ДАННЫХ: СНАЧАЛА ФАКТЫ О КОНКРЕТНОЙ БУТЫЛКЕ

Если результат поиска по базе знаний (RAG) содержит подтверждённые факты именно об этой бутылке или винтаже -- используй их первыми и говори о них уверенно, без маркеров вероятности.
Если данных о конкретной бутылке мало или их нет, разрешается дать только правдоподобную стилистическую ноту по характеру сорта или региона в целом, обязательно с одним из трёх разрешённых маркеров вероятности выше. Никогда не выдавай такую ноту за данные производителя, техническую карту или лабораторный анализ.

ШЕСТЬ ЭТАЛОННЫХ ПРИМЕРОВ (только молдавский материал, разговорная речь для озвучивания)

${REFERENCE_EXAMPLES.map((example, index) => `${index + 1}. «${example}»`).join('\n')}`;

const START_MARKER = '<!-- VOICE_SOMMELIER_STYLE_MOLDOVA_START -->';
const END_MARKER = '<!-- VOICE_SOMMELIER_STYLE_MOLDOVA_END -->';

const crypto = require('crypto');

function hashText(text) {
    return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 12);
}

function buildVoiceSommelierStyleBlock() {
    const text = `${START_MARKER}\n${MODULE_TEXT}\n${END_MARKER}`;
    return {
        text,
        meta: {
            id: MODULE_ID,
            version: MODULE_VERSION,
            chars: MODULE_TEXT.length,
            hash: hashText(MODULE_TEXT),
        },
    };
}

// Per-turn guidance on which data source may be spoken as fact vs. only as
// a hedged stylistic note -- mirrors the standing MODULE_TEXT rule above in
// a form that can be composed dynamically (e.g. per RAG lookup result) and
// unit-tested without a live model call. Unlike a response-length
// classifier, this is genuinely usable per turn: it depends on the actual
// RAG lookup result for that turn, which the response-length rule does not.
function buildRagPriorityGuidance({ hasBottleCard = false } = {}) {
    if (hasBottleCard) {
        return 'В базе знаний есть подтверждённые данные об этой конкретной бутылке -- говори о них уверенно, как о факте, без маркеров вероятности.';
    }
    return `Подробной карточки об этой конкретной бутылке нет. Можно дать только правдоподобную стилистическую ноту по характеру сорта или региона, обязательно с одним из маркеров: «${ALLOWED_PROBABILISTIC_MARKERS[0]}», «${ALLOWED_PROBABILISTIC_MARKERS[1]}», «${ALLOWED_PROBABILISTIC_MARKERS[2]}». Не выдавай такую ноту за данные производителя.`;
}

function containsAllowedProbabilisticMarker(text) {
    const normalized = String(text || '');
    return ALLOWED_PROBABILISTIC_MARKERS.some((marker) => normalized.includes(marker));
}

module.exports = {
    MODULE_ID,
    MODULE_VERSION,
    MOLDOVAN_VARIETIES,
    MOLDOVAN_REGIONS,
    ALLOWED_PROBABILISTIC_MARKERS,
    REFERENCE_EXAMPLES,
    SHORT_ANSWER_EXAMPLES,
    MODULE_TEXT,
    START_MARKER,
    END_MARKER,
    buildVoiceSommelierStyleBlock,
    buildRagPriorityGuidance,
    containsAllowedProbabilisticMarker,
    hashText,
};
