'use strict';

// One-shot greeting policy for the first meaningful user turn.
// Kept in persona-space so realtime transport / barge-in / provider rotation
// semantics remain completely untouched.
const FIRST_FOREIGN_WELCOME_INSTRUCTION = `ПЕРВОЕ ПРИВЕТСТВИЕ ИНОСТРАННОГО ГОСТЯ
Если первая содержательная реплика сессии ясно произнесена НЕ на русском и НЕ на румынском, начни первый ответ с короткого эквивалента «Welcome to Moldova!» на том же языке (Bienvenue en Moldavie ! / Willkommen in Moldau! / ¡Bienvenido a Moldavia! / モルドバへようこそ！) и сразу продолжай по существу. Произносится только один раз за сессию, никогда не повторяй. Для русского и румынского не добавляй. Если язык первой реплики неясен — дождись ясной содержательной реплики.`;

function appendFirstForeignWelcomeInstruction(prompt) {
    const base = String(prompt || '').trim();
    return `${base}\n\n${FIRST_FOREIGN_WELCOME_INSTRUCTION}`.trim();
}

module.exports = {
    FIRST_FOREIGN_WELCOME_INSTRUCTION,
    appendFirstForeignWelcomeInstruction,
};
