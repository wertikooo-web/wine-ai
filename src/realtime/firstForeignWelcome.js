'use strict';

const LOCAL_LANGUAGES = new Set(['ru', 'ro']);

const WELCOME_BY_LANGUAGE = Object.freeze({
    en: 'Welcome to Moldova!',
    fr: 'Bienvenue en Moldavie !',
    it: 'Benvenuto in Moldavia!',
    es: '¡Bienvenido a Moldavia!',
    de: 'Willkommen in Moldau!',
    zh: '欢迎来到摩尔多瓦！',
    ja: 'モルドバへようこそ！',
});

function normalizeLanguage(language) {
    return String(language || '').trim().toLowerCase();
}

function shouldSendForeignWelcome({ language, alreadySent = false } = {}) {
    const normalized = normalizeLanguage(language);
    return Boolean(normalized && !alreadySent && !LOCAL_LANGUAGES.has(normalized));
}

function getForeignWelcomeText(language) {
    const normalized = normalizeLanguage(language);
    return WELCOME_BY_LANGUAGE[normalized] || null;
}

function buildFirstTurnWelcomeInstruction({ language, alreadySent = false } = {}) {
    const normalized = normalizeLanguage(language);
    if (!shouldSendForeignWelcome({ language: normalized, alreadySent })) return null;

    const fixedText = getForeignWelcomeText(normalized);
    if (fixedText) {
        return `This is the user's first meaningful turn in a foreign language (${normalized}). Begin your next reply with exactly: ${fixedText} Continue the rest of the reply naturally in ${normalized}. Do this once only for this session.`;
    }

    return `This is the user's first meaningful turn in a foreign language (${normalized}). Begin your next reply with a short, natural equivalent of “Welcome to Moldova!” in ${normalized}, then continue the rest of the reply naturally in the same language. Do this once only for this session.`;
}

module.exports = {
    LOCAL_LANGUAGES,
    WELCOME_BY_LANGUAGE,
    normalizeLanguage,
    shouldSendForeignWelcome,
    getForeignWelcomeText,
    buildFirstTurnWelcomeInstruction,
};
