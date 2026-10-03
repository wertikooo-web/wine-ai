'use strict';

// "Not from the catalog" flag (src/observability/wineNameCheck.js): proper
// names in the answer are checked against registry / catalog / companion /
// question / evidence; unknown ones land in flags.unverified_names. Also the
// recordTurn enrich hook (the row is still written when the hook fails).

const t = require('./helpers/assertions');
const check = require('../src/observability/wineNameCheck');
const journal = require('../src/observability/turnJournal');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CATALOG = ['Purcari Negru de Purcari 2019', 'Castel Mimi Feteasca Neagra Reserve'];

async function run() {
    let n = 0;
    const ok = (c, m) => { t.ok(c, m); n += 1; };
    const names = (answer, extra = {}) => check.checkAnswer({ answer, question: '', tools: [], ...extra }, { catalog: CATALOG, entities: ['Purcari', 'Пуркари', 'Cricova', 'Крикова'], companion: [] });

    ok(check.skeleton('Пуркарь') === check.skeleton('Purcari') && check.skeleton('Пуркарей') === check.skeleton('Purcari'), 'Cyrillic and Latin spellings share a skeleton');
    ok(names('Советую Негру де Пуркарь 2019 от Пуркари.').length === 0, 'catalog wine named in Russian is known');
    ok(JSON.stringify(names('А ещё есть Шато Марго — легенда Бордо.')) === '["Шато Марго"]', 'wine outside the catalog is flagged, places are not');
    ok(JSON.stringify(names('Try Château Margaux or «Kagor Supreme».')) === '["Kagor Supreme","Château Margaux"]', 'Latin and quoted names flagged');
    ok(names('Попробуйте Фетяска Нягрэ от Кастель Мими, это классика Молдовы. Я Мария!').length === 0, 'grapes, places, persona and catalog winery are not flagged');
    ok(names('Hello! I am Maria from Wine.md. Cricova Brut is great.').length === 0, 'sentence-start words and known producers are not flagged');
    ok(names('Шато Марго прекрасно.', { question: 'Расскажи про Шато Марго' }).length === 0, 'name the guest said is not flagged');
    ok(names('Это Vinaria Bostavan Dor.', { tools: [{ evidence: [{ title: 'Bostavan DOR collection' }] }] }).length === 0, 'name from tool evidence is not flagged');

    const row = { id: 'x1', answer: 'Попробуйте Шато Марго.', question: 'Что выпить?', tools: [], flags: { a: 1 } };
    const enriched = await check.checkWineNames(row, { loadCatalog: async () => CATALOG, env: {} });
    ok(enriched.flags.a === 1 && enriched.flags.unverified_names[0] === 'Шато Марго' && !enriched.flags.name_check_without_catalog, 'enrich adds the flag, keeps other flags');
    const noDb = await check.checkWineNames(row, { loadCatalog: async () => null, env: {} });
    ok(noDb.flags.name_check_without_catalog === true, 'missing catalog is marked');
    ok((await check.checkWineNames(row, { loadCatalog: async () => CATALOG, env: { TURN_JOURNAL_NAME_CHECK: 'off' } })) === row, 'switch off leaves the row');

    const store = journal.createMemoryTurnStore();
    journal.recordTurn(row, { store, env: { TURN_JOURNAL_TEXT: 'off' }, enrich: (r) => check.checkWineNames(r, { loadCatalog: async () => CATALOG, env: {} }) });
    journal.recordTurn({ ...row, id: 'x2' }, { store, env: {}, enrich: async () => { throw new Error('boom'); } });
    await sleep(20);
    const a = store._rows.find((r) => r.id === 'x1');
    const b = store._rows.find((r) => r.id === 'x2');
    ok(a && a.answer === null && a.flags.unverified_names[0] === 'Шато Марго', 'check sees the text even when the stored row drops it');
    ok(b && b.answer === row.answer && !b.flags.unverified_names, 'failing enrich still records the row');
    return { assertionCount: n };
}

module.exports = { run };

if (require.main === module) {
    run().then((r) => { console.log(`wineNameCheck passed (${r.assertionCount})`); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}
