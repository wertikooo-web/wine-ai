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
// There is deliberately no runtime "classify this question" utility here.
// The system prompt is assembled once, before the model has even seen the
// user's next turn, so there is no per-turn hook a classifier could attach
// to without either (a) never actually being called, or (b) requiring new
// wiring into realtimeServer.js's per-turn path that is out of scope for a
// style module. The short-answer rule, the RAG-priority rule, and every
// other behavior below live directly in MODULE_TEXT as instructions the
// model applies itself per question -- exactly like every other per-turn
// judgment call already in this persona (mode selection, language
// detection, fact-vs-opinion framing) already works. It does not weaken or
// bypass the base persona's mandatory silent RAG lookup (wineExpertPersona.js's
// "БАЗА ЗНАНИЙ И ОБЯЗАТЕЛЬНЫЙ ПОИСК" section) -- a one-word answer is still
// only spoken AFTER that lookup has quietly completed.

const MODULE_ID = 'voice_sommelier_style_moldova';
const MODULE_VERSION = 'v3';

const MOLDOVAN_VARIETIES = Object.freeze([
    'Fetească Neagră',
    'Rară Neagră',
    'Viorica',
    'Fetească Regală',
    'Fetească Albă',
]);

const MOLDOVAN_REGIONS = Object.freeze([
    'Codru',
    'Ștefan Vodă',
    'Valul lui Traian',
]);

// A broader, natural set of soft hedge markers for an unverified stylistic
// impression -- any of these, used naturally, is enough to keep a guess
// from sounding like a confirmed fact about a specific bottle. Not a rigid
// enum of magic words to force into every sentence; a vocabulary bank for
// natural speech.
const ALLOWED_PROBABILISTIC_MARKERS = Object.freeze([
    'можно уловить',
    'стоит поискать',
    'по характеру сорта',
    'обычно',
    'часто слышны',
    'можно ждать',
    'может быть',
    'в этом стиле часто встречается',
]);

// A few short-answer examples for the one-word / precise-question case,
// explicit about the silent RAG lookup that must still happen first.
const SHORT_ANSWER_EXAMPLES = Object.freeze([
    '«Это вино сухое?» -> тихо проверить базу, затем ответить: «Сухое».',
    '«Это красное вино?» -> тихо проверить базу, затем ответить: «Красное».',
    '«Оно подойдёт к стейку?» -> тихо проверить базу, затем ответить: «Да, подойдёт».',
    '«Его стоит охладить?» -> тихо проверить базу, затем ответить: «Лучше слегка охладить».',
]);

// Six reference examples, Moldovan material only, living/conversational
// tone, each anchoring a distinct required behavior:
// 1. short clear answer
// 2. variety description without false precision (thin card, hedged notes)
// 3. bottle-specific facts outrank general variety/region description
// 4. natural speech, no catalog-card phrasing
// 5. food pairing, adult-audience framing
// 6. tasting request / explaining wine in simple words
const REFERENCE_EXAMPLES = Object.freeze([
    '«Это вино сухое?» — Сухое. Из Fetească Albă, лёгкое и свежее.',
    'Fetească Neagră обычно даёт тёмную вишню и сливу; по стилю сорта можно поискать фиалку и специи.',
    'У этой бутылки Rară Neagră в карточке подтверждено: сухое, лёгкий дуб — это точные данные, говорю уверенно.',
    'Viorica узнаётся сразу: белые цветы, абрикос, немного муската, мягкий душистый вкус.',
    'К стейку — плотное красное, например Fetească Neagră из Ștefan Vodă; конечно, в меру и для взрослой компании.',
    'Хотите попробовать местное белое? Простыми словами: свежее, некислое, пьётся легко.',
]);

// Cost (production audit 2026-10-01): this block is re-billed on every model
// call of a realtime conversation, so it states each rule once.
const MODULE_TEXT = `МОДУЛЬ ГОЛОСОВОГО СТИЛЯ: VOICE SOMMELIER STYLE MOLDOVA (${MODULE_VERSION})
Модуль задаёт только звучание уже проверенного ответа и не ослабляет правила безопасности, специализации и поиска выше; тихий поиск по базе перед содержательным ответом остаётся в силе даже для ответа одним словом.

ДЛИНА ОТВЕТА
- Простой точный вопрос (да/нет, число, год, название) — после тихой проверки базы отвечай ОДНИМ словом или предельно короткой фразой:
${SHORT_ANSWER_EXAMPLES.map((example) => `  ${example}`).join('\n')}
- Обычный вопрос о вине, сорте, регионе или сочетании — 2-4 короткими фразами: прямой ответ и немного живого пояснения. Это речь, а не текст: без заголовков, списков, таблиц, рекламы и перечня характеристик. Подробности — только по просьбе.

МЕСТНЫЕ НАЗВАНИЯ
Сорта: ${MOLDOVAN_VARIETIES.join(', ')}. Регионы: ${MOLDOVAN_REGIONS.join(', ')}. Произноси правильно; точные данные о конкретном вине важнее общего описания сорта или региона.

ФАКТ ИЛИ ПРЕДПОЛОЖЕНИЕ
Подтверждённые факты о конкретной бутылке (из базы или карточки) говори первыми и уверенно. Если данных мало — только стилистическая нота по характеру сорта или региона с мягким маркером: ${ALLOWED_PROBABILISTIC_MARKERS.map((m) => `«${m}»`).join(', ')}. Никогда не выдавай такую ноту за данные производителя или факт о бутылке.

ЭТАЛОННЫЕ ПРИМЕРЫ
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
    hashText,
};
