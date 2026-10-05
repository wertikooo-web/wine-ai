'use strict';

// Service lines of a /lite Free Conversation (30-second warning, session
// end, inactivity check-in and goodbye), pre-rendered in the persona's voice
// and played by the client like a bridge phrase.
//
// Before, the client asked the MODEL to say them ("[system instruction,
// speak this exact sentence verbatim]"). Prod 2026-10-05 (turn journal):
// the 30-second warning was cut after 0.4 s twice (native_speech_started:
// the guest was talking), and once the closing line never came at all (the
// guest was mid-sentence at 0:00, Gemini waited for the end of the
// utterance, the 10 s fallback ended the conversation in silence). A
// pre-rendered line cannot be interrupted, delayed or rephrased by the
// model, and costs no model turn.
//
// Texts must match public/dashboard.html (FREE_CONV_* constants and
// SCRIPTED_LINE_TRANSLATIONS) exactly; KEYS give the index in each list.

const KEYS = Object.freeze(['session_warning', 'session_limit', 'inactivity_warning', 'inactivity_goodbye']);

const LINES = Object.freeze({
    ru: [
        'У нас осталось полминуты. Давайте успеем разобрать последний вопрос.',
        'Мне пора немного отдохнуть. Если захотите продолжить, начните новый разговор.',
        'Вы ещё здесь? Если хотите продолжить, просто скажите что-нибудь или нажмите кнопку.',
        'Похоже, мы сделали небольшую паузу. Я завершу разговор. Возвращайтесь, когда захотите продолжить.',
    ],
    ro: [
        'Ne-a mai rămas o jumătate de minut. Hai să apucăm să discutăm ultima întrebare.',
        'E timpul să mă odihnesc puțin. Dacă vreți să continuăm, începeți o conversație nouă.',
        'Mai sunteți aici? Dacă vreți să continuăm, spuneți ceva sau apăsați butonul.',
        'Se pare că am făcut o mică pauză. Închei conversația. Reveniți oricând doriți să continuăm.',
    ],
    en: [
        'We have about half a minute left. Let us make time for one last question.',
        'It is time for me to take a little rest. If you would like to continue, please start a new conversation.',
        'Are you still there? If you would like to continue, just say something or press the button.',
        'It looks like we have taken a little break. I will end our conversation now. Come back whenever you would like to continue.',
    ],
});

function enabled(env = process.env) {
    return String(env.SCRIPTED_LINES_AUDIO || 'on').toLowerCase() !== 'off';
}

function lookup(key, lang) {
    const index = KEYS.indexOf(String(key || ''));
    if (index < 0) return null;
    const l = LINES[String(lang || '').slice(0, 2).toLowerCase()] ? String(lang).slice(0, 2).toLowerCase() : 'ru';
    return { index, lang: l, text: LINES[l][index] };
}

module.exports = { KEYS, LINES, enabled, lookup };
