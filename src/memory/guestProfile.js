'use strict';

// Guest profile: what the guest said about their taste reaches the model.
//
// Voice bench on prod (group "memory"): the guest said "I love sweet white
// wines, I don't drink red, budget up to 200 lei"; three turns later Maria
// asked "red or white, dry or sweet?". In Free Conversation the Gemini
// connection is continuous, its sliding context window drops early turns
// after a few tool results, and sessionMemory reaches the system
// instruction only on a reconnect. Two cheap, deterministic fixes:
//   1. extractGuestFacts(): the server records stated taste (colour,
//      sweetness, dislikes, budget) from the guest's own words -- it does not
//      depend on the model calling update_session_memory.
//   2. withGuestProfile(): every wine tool result carries a short
//      guest_profile block, so the facts sit in fresh context exactly when
//      the model picks a wine.
// SESSION_MEMORY_IN_TOOLS=off switches 2 off.

// \B< / \B> mark word start / end and also work for Cyrillic and Romanian
// diacritics (JavaScript's \b only knows [A-Za-z0-9_]).
const W = (src) => new RegExp(src.replace(/\\B</g, '(?<!\\p{L})').replace(/\\B>/g, '(?!\\p{L})'), 'iu');

const COLOURS = [
    { key: 'red', re: W('\\B<(красн|ro[sș]u|ro[sș]ii|ro[sș]ie|reds?)') },
    { key: 'white', re: W('\\B<(бел(ое|ые|ого|ых|ую|ая)|alb[ae]?\\B>|albe\\B>|whites?\\B>)') },
    { key: 'rosé', re: W('\\B<(розов|roz[eé]\\B>|ros[eé]s?\\B>)') },
    { key: 'sparkling', re: W('\\B<(игрист|шампанск|spumant|sparkling|prosecco)') },
];
const SWEETNESS = [
    { key: 'semi-dry', re: W('\\B<(полусух|demi-?sec|off-?dry|semi-?dry)') },
    { key: 'semi-sweet', re: W('\\B<(полуслад|demi-?dulc|semi-?sweet)') },
    { key: 'dry', re: W('\\B<(сух(ое|ие|ого|их|ую|ой|ая)?\\B>|seci?\\B>|dry\\B>)') },
    { key: 'sweet', re: W('\\B<(сладк|десертн|dulc[ei]\\B>|sweet\\B>)') },
];

// First-person taste statements only ("I love…", "I don't drink…"), so a
// question like "which white goes with fish?" is not stored as a taste.
const LIKE = W('\\B<(люблю|обожаю|предпочитаю|нравится|нравятся|пью|выбираю|îmi plac|imi plac|iubesc|prefer|beau|i (like|love|prefer|drink|enjoy))\\B>');
const DISLIKE = W('\\B<(не (пью|люблю|нравится|нравятся|переношу|хочу|употребляю)|nu (beau|îmi place|imi place|îmi plac|imi plac|vreau|iubesc)|nu-mi plac|i (don\'t|do not|never|dont) (drink|like|want)|i hate)\\B>');
const BUDGET = /(\d[\d\s]{0,6})\s*(лей|леев|lei|mdl|евро|eur|€|\$|долл|dollars?)/iu;
const BUDGET_CUE = W('бюджет|\\B<до \\d|не дороже|budget|până la|pana la|maxim|under|up to|no more than');

function tasteIn(text) {
    const colour = COLOURS.filter((c) => c.re.test(text)).map((c) => c.key);
    const sweet = SWEETNESS.filter((s) => s.re.test(text)).map((s) => s.key);
    if (!colour.length && !sweet.length) return null;
    return `${sweet.join('/')}${sweet.length && colour.length ? ' ' : ''}${colour.join('/')}`.trim();
}

// Splits on clause boundaries so "I love sweet whites and I don't drink red"
// yields a like AND a dislike.
function extractGuestFacts(text) {
    const s = String(text || '').trim().replace(/ё/g, 'е');
    const facts = { likes: [], dislikes: [], budget: null };
    if (!s) return facts;
    for (const clause of s.split(/[.,;!?—]|\s(?:и|а|но|și|dar|iar|and|but)\s/iu)) {
        const c = clause.trim();
        if (!c) continue;
        if (DISLIKE.test(c)) {
            const taste = tasteIn(c);
            if (taste) facts.dislikes.push(taste);
        } else if (LIKE.test(c)) {
            const taste = tasteIn(c);
            if (taste) facts.likes.push(taste);
        }
    }
    const b = s.match(BUDGET);
    if (b && BUDGET_CUE.test(s)) facts.budget = `up to ${b[1].replace(/\s+/g, '')} ${b[2]}`;
    return facts;
}

function applyGuestFacts(memory, text) {
    if (!memory) return null;
    const facts = extractGuestFacts(text);
    for (const like of facts.likes) memory.recordPreference(`likes ${like} wine`);
    for (const dislike of facts.dislikes) memory.recordDislikedStyle(`${dislike} wine`);
    if (facts.budget) memory.setBudget(facts.budget);
    return facts;
}

function profileOf(memory) {
    if (!memory || typeof memory.snapshot !== 'function') return null;
    const s = memory.snapshot();
    const profile = {};
    if (s.preferences && s.preferences.length) profile.likes = s.preferences.slice(-6);
    if (s.dislikedStyles && s.dislikedStyles.length) profile.avoid = s.dislikedStyles.slice(-6);
    if (s.budget) profile.budget = s.budget;
    if (s.occasion) profile.occasion = s.occasion;
    if (s.plannedDish) profile.planned_dish = s.plannedDish;
    if (!Object.keys(profile).length) return null;
    profile.note = 'Told by the guest earlier in this conversation. Recommend accordingly and do not ask for it again.';
    return profile;
}

// Wine-choosing tools only; project/info/link tools stay untouched.
const PROFILE_TOOLS = new Set(['search_wine_knowledge', 'recommend_wine_pairing', 'recommend_wine_serving', 'check_wine_md_availability', 'search_winery', 'compare_grape_varieties']);

function enabled(env = process.env) {
    return String(env.SESSION_MEMORY_IN_TOOLS || 'on').toLowerCase() !== 'off';
}

function withGuestProfile(handlers, memory, { env = process.env } = {}) {
    if (!enabled(env) || !handlers || typeof handlers !== 'object' || !memory) return handlers;
    const wrapped = { ...handlers };
    for (const [name, handler] of Object.entries(handlers)) {
        if (!PROFILE_TOOLS.has(name) || typeof handler !== 'function') continue;
        wrapped[name] = async (call) => {
            const result = await handler(call);
            const profile = profileOf(memory);
            if (!profile || !result || typeof result !== 'object' || Array.isArray(result)) return result;
            return { ...result, guest_profile: profile };
        };
    }
    return wrapped;
}

module.exports = { extractGuestFacts, applyGuestFacts, profileOf, withGuestProfile, enabled, PROFILE_TOOLS };
