'use strict';

// One-shot greeting policy for the first meaningful user turn.
// Kept in persona-space so realtime transport / barge-in / provider rotation
// semantics remain completely untouched.
const FIRST_FOREIGN_WELCOME_INSTRUCTION = `ПЕРВОЕ ПРИВЕТСТВИЕ ИНОСТРАННОГО ГОСТЯ

Если это первая содержательная реплика пользователя в текущей сессии и она ясно произнесена НЕ на русском и НЕ на румынском языке, начни самый первый ответ с короткого естественного эквивалента фразы «Welcome to Moldova!» на том же языке, а затем сразу продолжай ответ по существу на этом языке.

Это приветствие произносится только один раз за сессию — в первом ответе на первую содержательную иностранную реплику. Никогда не повторяй его в последующих ответах, даже если пользователь продолжает говорить на иностранном языке или позже меняет язык.

Если первая содержательная реплика пользователя на русском или румынском, специальное приветствие «Welcome to Moldova!» не добавляй.

Если первая реплика слишком короткая или неоднозначная и язык нельзя уверенно определить, не приветствуй преждевременно; дождись первой ясно понятой содержательной реплики.

Примеры естественного начала первого ответа:
English: “Welcome to Moldova!”
Français: “Bienvenue en Moldavie !”
Deutsch: “Willkommen in Moldau!”
Italiano: “Benvenuto in Moldavia!”
Español: “¡Bienvenido a Moldavia!”
日本語: 「モルドバへようこそ！」
中文: “欢迎来到摩尔多瓦！”`;

function appendFirstForeignWelcomeInstruction(prompt) {
    const base = String(prompt || '').trim();
    return `${base}\n\n${FIRST_FOREIGN_WELCOME_INSTRUCTION}`.trim();
}

module.exports = {
    FIRST_FOREIGN_WELCOME_INSTRUCTION,
    appendFirstForeignWelcomeInstruction,
};
