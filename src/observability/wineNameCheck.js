'use strict';

// "Not from the catalog" flag for the turn journal (observation only).
// Before a journal row is written, proper-name phrases in the assistant's
// answer are checked against what the system actually knows: the canonical
// entity registry, Wine.md catalog product titles, published companion wines,
// the guest's own question and the titles of the evidence the tools returned.
// A phrase most of whose words are unknown lands in flags.unverified_names,
// so an operator can review possible invented wines in /api/turns.
//
// Heuristic by design: Russian answers name wines in Cyrillic while the
// catalog is in Latin, so words are compared by a phonetic consonant skeleton
// ("Пуркарь" and "Purcari" both become "prkr"). It errs towards "known" —
// fewer false alarms, some misses. It never changes what the guest hears.

const { normalizeName } = require('../companion/companionCatalog');

const CATALOG_TTL_MS = 10 * 60 * 1000;
const MAX_FLAGGED = 5;

const RU_LATIN = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '',
    ы: 'y', ь: '', э: 'e', ю: 'iu', я: 'ia', і: 'i', ї: 'i', є: 'e',
};

// Words that are capitalized in answers but are not wine names: places,
// grapes, styles, the brand and the personas. Compared by skeleton, so one
// spelling per word is enough.
const COMMON_WORDS = [
    'moldova', 'moldavia', 'moldovan', 'chisinau', 'kishinev', 'romania', 'france', 'italy', 'spain', 'portugal',
    'germany', 'austria', 'georgia', 'ukraine', 'russia', 'europe', 'europa', 'bordeaux', 'bourgogne', 'burgundy',
    'champagne', 'toscana', 'tuscany', 'rioja', 'codru', 'codri', 'stefan', 'voda', 'valul', 'traian', 'bugeac',
    'gagauzia', 'orhei', 'cahul', 'balti', 'tiraspol', 'dniester', 'nistru', 'prut',
    'feteasca', 'neagra', 'alba', 'regala', 'rara', 'cabernet', 'sauvignon', 'merlot', 'pinot', 'noir', 'gris',
    'grigio', 'chardonnay', 'riesling', 'traminer', 'aligote', 'rkatsiteli', 'saperavi', 'muscat', 'moscato',
    'malbec', 'shiraz', 'syrah', 'viorica', 'sangiovese', 'tempranillo', 'zinfandel', 'gewurztraminer', 'blanc',
    'franc', 'rose', 'brut', 'demi', 'reserve', 'rezerva', 'riserva', 'selection', 'collection', 'premium', 'grand',
    'cuvee', 'vintage', 'classic', 'divin', 'brandy', 'cognac', 'wine', 'wines', 'winery', 'vinaria', 'chateau',
    'domaine', 'castel', 'maria', 'alexandru', 'alexander', 'kagor',
    // Russian spellings whose skeleton differs from the original (silent
    // letters, "gn" -> "нь")
    'молдова', 'кишинев', 'бордо', 'бургундия', 'шампань', 'шампанское', 'тоскана', 'риоха', 'кодры', 'штефан',
    'фетяска', 'нягрэ', 'рарэ', 'совиньон', 'шардоне', 'мерло', 'пино', 'нуар', 'рислинг', 'мускат', 'каберне',
    'саперави', 'ркацители', 'траминер', 'алиготе', 'мальбек', 'шираз', 'сира', 'виорика', 'брют', 'резерва',
    'шато', 'кагор', 'мария', 'александру', 'дивин', 'коньяк', 'бренди',
    // English sentence words that are capitalized mid-phrase in transcripts
    'hello', 'thank', 'thanks', 'please', 'great', 'this', 'that', 'there', 'they', 'what', 'which', 'with',
];

function transliterate(text) {
    return String(text || '').toLowerCase().replace(/[а-яёіїє]/g, (ch) => RU_LATIN[ch] ?? ch);
}

// Phonetic consonant skeleton of one word: transliterated, diacritics off,
// similar sounds merged, doubles collapsed, vowels dropped after the first
// letter. Case endings (Пуркари / Пуркарей / Purcari) end up identical.
function skeleton(word) {
    let s = transliterate(word).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
    if (!s) return '';
    s = s.replace(/sch/g, 's').replace(/sh/g, 's').replace(/zh/g, 'z').replace(/ch/g, 'k').replace(/ts|tz/g, 't')
        .replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/[cq]/g, 'k').replace(/x/g, 'ks').replace(/w/g, 'v')
        .replace(/j/g, 'z').replace(/h/g, '');
    s = s.replace(/(.)\1+/g, '$1');
    if (!s) return '';
    return s[0] + s.slice(1).replace(/[aeiouy]/g, '');
}

function wordsOf(text) {
    return String(text || '').match(/[\p{L}][\p{L}'’-]*/gu) || [];
}

// Only words of 4+ letters carry a name; "de", "lui", "la" never decide.
function significant(word) {
    return word.replace(/['’-]/g, '').length >= 4;
}

function addSkeletons(set, text) {
    for (const w of wordsOf(text)) {
        if (!significant(w)) continue;
        const k = skeleton(w);
        if (k.length >= 2) set.add(k);
    }
}

const STATIC_KNOWN = (() => {
    const set = new Set();
    for (const w of COMMON_WORDS) addSkeletons(set, w);
    return set;
})();

const UPPER = /^[\p{Lu}]/u;

// Proper-name phrases: «quoted» / "quoted" segments of up to 6 words, and runs
// of capitalized words. A run that opens a sentence loses its first word
// (it is capitalized for grammar, not because it is a name).
function extractCandidates(answer) {
    const text = String(answer || '');
    const out = [];
    const quoted = /[«"“]([^«»"“”]{2,80})[»"”]/g;
    let m;
    while ((m = quoted.exec(text))) {
        const phrase = m[1].trim();
        if (phrase && wordsOf(phrase).length <= 6) out.push(phrase);
    }
    const tokens = text.match(/[\p{L}][\p{L}'’-]*|[.!?…]+|[^\s\p{L}]/gu) || [];
    let run = [];
    let runAtStart = false;
    let sentenceStart = true;
    const flush = () => {
        const words = runAtStart ? run.slice(1) : run;
        if (words.length && words.length <= 6) out.push(words.join(' '));
        run = [];
        runAtStart = false;
    };
    for (const tok of tokens) {
        const isWord = /^\p{L}/u.test(tok);
        if (isWord && UPPER.test(tok)) {
            if (!run.length) runAtStart = sentenceStart;
            run.push(tok);
        } else if (isWord && run.length && /^(de|da|di|du|la|le|lui|del|della|von|van|де|да|ди|дю|ла|ле|луй|дель)$/i.test(tok)) {
            run.push(tok); // "Negru de Purcari", "Valul lui Traian"
        } else {
            if (run.length) {
                while (run.length && !UPPER.test(run[run.length - 1])) run.pop();
                flush();
            }
        }
        if (isWord) sentenceStart = false;
        else if (/^[.!?…]+$/.test(tok)) sentenceStart = true;
    }
    if (run.length) {
        while (run.length && !UPPER.test(run[run.length - 1])) run.pop();
        flush();
    }
    return [...new Set(out)];
}

// Common words (grapes, places, "Château", "Reserve") never identify a wine,
// so they are left out; a phrase is unverified when fewer than half of its
// remaining significant words are known. Phrases with none left are ignored.
function unverifiedNames(answer, known) {
    const flagged = [];
    for (const phrase of extractCandidates(answer)) {
        const keys = wordsOf(phrase).filter(significant).map(skeleton).filter((k) => k.length >= 2 && !STATIC_KNOWN.has(k));
        if (!keys.length) continue;
        const hits = keys.filter((k) => known.has(k)).length;
        if (hits * 2 < keys.length) flagged.push(phrase);
        if (flagged.length >= MAX_FLAGGED) break;
    }
    return flagged;
}

function entityNames() {
    try {
        const { aliasesFilePath } = require('../knowledge/entityResolver');
        const data = JSON.parse(require('fs').readFileSync(aliasesFilePath(), 'utf8'));
        const names = [];
        for (const e of data) {
            names.push(e.canonicalName);
            for (const a of e.aliases || []) names.push(a.alias);
        }
        return names;
    } catch {
        return [];
    }
}

function companionNames() {
    try {
        const { getIndexSync } = require('../companion/companionCatalog');
        return getIndexSync().flatMap((e) => [e.wineName, e.wineryName, ...(e.names || [])]);
    } catch {
        return [];
    }
}

let catalogCache = { at: 0, titles: null, pending: null };

async function catalogTitles({ now = Date.now } = {}) {
    if (catalogCache.titles && now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.titles;
    if (catalogCache.pending) return catalogCache.pending;
    const db = require('../knowledge/db');
    const pool = db.getPool();
    if (!pool) return null;
    catalogCache.pending = pool.query('SELECT title FROM catalog_products LIMIT 50000')
        .then(({ rows }) => {
            catalogCache = { at: now(), titles: rows.map((r) => r.title), pending: null };
            return catalogCache.titles;
        })
        .catch(() => { catalogCache.pending = null; return catalogCache.titles; });
    return catalogCache.pending;
}

function rowContext(row) {
    const texts = [row.question || ''];
    for (const tool of row.tools || []) {
        for (const ev of tool.evidence || []) texts.push(ev.title || '', ev.id || '');
    }
    return texts;
}

// Builds the known-name set and checks one answer. Sources are injectable
// for tests; in production they come from the registry, catalog and index.
function checkAnswer(row, { catalog = null, entities = entityNames(), companion = companionNames() } = {}) {
    if (!row || !row.answer) return [];
    const known = new Set();
    for (const name of entities) addSkeletons(known, name);
    for (const name of companion) addSkeletons(known, name);
    for (const title of catalog || []) addSkeletons(known, title);
    for (const text of rowContext(row)) addSkeletons(known, text);
    return unverifiedNames(row.answer, known);
}

function enabled(env = process.env) {
    return String(env.TURN_JOURNAL_NAME_CHECK || 'on').toLowerCase() !== 'off';
}

// Journal enrich hook: returns the row with flags.unverified_names set when
// something did not match. Never throws; a failure leaves the row as is.
async function checkWineNames(row, { env = process.env, loadCatalog = catalogTitles } = {}) {
    if (!enabled(env) || !row || !row.answer) return row;
    try {
        const catalog = await loadCatalog();
        const names = checkAnswer(row, { catalog });
        if (!names.length) return row;
        const flags = { ...(row.flags || {}), unverified_names: names };
        if (!catalog) flags.name_check_without_catalog = true;
        return { ...row, flags };
    } catch {
        return row;
    }
}

module.exports = {
    checkWineNames,
    checkAnswer,
    extractCandidates,
    unverifiedNames,
    skeleton,
    transliterate,
    enabled,
    _resetCatalogCache: () => { catalogCache = { at: 0, titles: null, pending: null }; },
};
