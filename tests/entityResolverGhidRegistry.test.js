'use strict';
/**
 * Coverage for the Ghid Vin-Divin producer registry import.
 *
 * Guards two things that must hold together:
 *   1. recall  — producers imported from the book actually resolve
 *   2. precision — the expansion did not make grape varieties, bare descriptors
 *      or fictional names start matching real wineries
 */
const assert = require('assert');
const { resolveEntity } = require('../src/knowledge/entityResolver');
const registry = require('../knowledge/entity-aliases.json');

// entityResolver is intentionally chatty; keep test output readable.
const _log = console.log;
console.log = () => {};
const done = [];
function test(name, fn) {
  try { fn(); done.push([name, null]); } catch (e) { done.push([name, e]); }
}
const resolves = (q, id) => {
  const r = resolveEntity(q);
  assert.strictEqual(r.found, true, `"${q}" should resolve, got NOT_FOUND`);
  assert.strictEqual(r.entityId, id, `"${q}" resolved to ${r.entityId}, expected ${id}`);
};
const doesNotResolve = (q) => {
  const r = resolveEntity(q);
  assert.strictEqual(r.found, false, `"${q}" must NOT resolve, but matched ${r.entityId} (${r.matchType})`);
};

// ---------------------------------------------------------------- major wineries
const MAJOR = [
  ['Purcari', 'purcari'], ['Chateau Purcari', 'purcari'], ['Cricova', 'cricova'],
  ['Mileștii Mici', 'mileshtii-mici'], ['Castel Mimi', 'castel-mimi'],
  ['Fautor', 'fautor'], ['Gitana', 'gitana'], ['KVINT', 'kvint'],
  ['Vinuri de Comrat', 'vinuri-de-comrat'], ['Novak', 'novak'],
  ['Asconi', 'asconi'], ['Basavin', 'basavin'], ['Et Cetera', 'et-cetera'],
  ['Château Vartely', 'chateau-vartely'], ['Bostavan', 'bostavan'],
  ['Imperial Vin', 'imperial-vin'], ['Romanești', 'romanesti'],
  ['Rădăcini', 'radacini'], ['Sălcuța', 'salcuta'], ['Aurvin', 'aurvin'],
];
test('20 major wineries resolve to themselves', () => MAJOR.forEach(([q, id]) => resolves(q, id)));

// -------------------------------------------- previously-missing, named in the brief
test('Aurelius resolves (was entirely absent before this import)', () => {
  resolves('Aurelius Winery', 'aurelius-winery');
  resolves('Aurelius', 'aurelius-winery');
});
test('Vinăria din Vale resolves, with and without diacritics', () => {
  resolves('Vinăria din Vale', 'vinaria-din-vale');
  resolves('Vinaria din Vale', 'vinaria-din-vale');
});
test('Lion Gri is absent from the Ghid book and must stay unresolved', () => {
  // Documented finding: "Lion Gri" appears nowhere in
  // knowledge/source/Ghid_Vin-Divin_Moldova__ro_en__7__Print.md, so this import
  // cannot add it. Asserting NOT_FOUND keeps the gap visible instead of silently
  // fuzzy-matching it onto some other producer.
  doesNotResolve('Lion Gri');
});

// ------------------------------------------------- 20+ lesser-known producers
const SMALLER = [
  ['Crama Ulinici', 'crama-ulinici'], ['Crama Mircești', 'crama-mircesti'],
  ['Crama Volintiri', 'crama-volintiri'], ['Crama Tataru', 'crama-tataru'],
  ['Crama Tudor', 'crama-tudor'], ['Crama Mingir', 'crama-mingir'],
  ['Crama Mihai Sava', 'crama-mihai-sava'], ['Domeniile Cuza', 'domeniile-cuza'],
  ['Domeniile Pripa', 'domeniile-pripa'], ['Domeniile Scutelnic', 'domeniile-scutelnic'],
  ['Domeniile Davidescu', 'domeniile-davidescu'], ['Chateau Cristi', 'chateau-cristi'],
  ['Chateau Cojușna', 'chateau-cojusna'], ['Chateau at Mount', 'chateau-at-mount'],
  ['Kara Gani', 'kara-gani'], ['Kazayak', 'kazayak'], ['Mezalimpe', 'mezalimpe'],
  ['Pelican Negru', 'pelican-negru'], ['Terra Dacia', 'terra-dacia'],
  ['Land of Basarabia', 'land-of-basarabia'], ['Vornic Winery', 'vornic-winery'],
  ['Winetage', 'winetage'], ['Unicorn Estate', 'unicorn-estate'],
  ['Vinum Estate', 'vinum-estate'], ['Minis Terrios', 'minis-terrios'],
];
test('25 lesser-known Ghid producers resolve', () => SMALLER.forEach(([q, id]) => resolves(q, id)));

// ------------------------------------------------------ diacritic / stripped pairs
const DIACRITIC_PAIRS = [
  ['Vinăria Poiana', 'Vinaria Poiana', 'vinaria-poiana'],
  ['Sălcuța', 'Salcuta', 'salcuta'],
  ['Rădăcini', 'Radacini', 'radacini'],
  ['Crama Mircești', 'Crama Mircesti', 'crama-mircesti'],
  ['Barza Albă', 'Barza Alba', 'barza-alba'],
  ['Château Vartely', 'Chateau Vartely', 'chateau-vartely'],
  ['Dumitraș Winery', 'Dumitras Winery', 'dumitras-winery'],
  ['Vinăria Brănești', 'Vinaria Branesti', 'vinaria-branesti'],
];
test('diacritic and stripped spellings resolve to the same entity', () => {
  DIACRITIC_PAIRS.forEach(([a, b, id]) => { resolves(a, id); resolves(b, id); });
});

// ------------------------------------------------- grape varieties must NOT match
const GRAPES = [
  'Cabernet Sauvignon', 'Pinot Noir', 'Fetească Neagră', 'Feteasca Neagra',
  'Sauvignon Blanc', 'Rară Neagră', 'Rara Neagra', 'Merlot', 'Saperavi',
  'Viorica', 'Traminer', 'Muscat Ottonel', 'Aligote', 'Pinot Gris',
  'Каберне Совиньон', 'Пино Нуар',
];
test('grape varieties do not resolve as wineries', () => GRAPES.forEach(doesNotResolve));

// ------------------------------------- bare descriptors must not become entities
test('bare name descriptors do not resolve', () => {
  ['Crama', 'Chateau', 'Domeniile', 'Winery', 'Estate', 'Vinaria', 'Vin'].forEach(doesNotResolve);
});

// -------------------------------------------------- fabricated names must not match
test('fabricated winery names do not fuzzy-match a real producer', () => {
  ['Crama Zzzyxia Nonexistent', 'Chateau Nonesuch', 'Vinaria Fantoma de Vale',
    'Winery Nonexistent SRL', 'Domeniile Qqqq'].forEach(doesNotResolve);
});

// --------------------------------------------------- wrong-entity contamination
test('every canonical name resolves to its own entity (no cross-contamination)', () => {
  for (const e of registry) {
    const r = resolveEntity(e.canonicalName);
    assert.strictEqual(r.found, true, `canonical "${e.canonicalName}" did not resolve`);
    assert.strictEqual(r.entityId, e.entityId,
      `canonical "${e.canonicalName}" resolved to ${r.entityId}, not its own id ${e.entityId}`);
  }
});

test('Timbrus Purcari Estate is not conflated with Purcari', () => {
  resolves('Timbrus Purcari Estate', 'timbrus-purcari-estate');
  resolves('Purcari', 'purcari');
  const r = resolveEntity('Where is Timbrus Purcari Estate located?');
  assert.strictEqual(r.entityId, 'timbrus-purcari-estate',
    `Timbrus question surfaced ${r.entityId}`);
});

test('a question about one winery does not surface a similarly-named other', () => {
  resolves('Ce vinuri face Crama Mircești?', 'crama-mircesti');
  resolves('Расскажи о винодельне Aurelius', 'aurelius-winery');
  resolves('Tell me about Vinăria din Vale', 'vinaria-din-vale');
});

// --------------------------------------------------------- word-boundary matching
// Regression: _isWordBoundaryMatch accepted a match when EITHER side was a word
// boundary, so a short alias embedded at the start of a longer word matched.
// Harmless with 15 entities; with 109 it made "dacă" fire the producer "DAC".
test('a short alias embedded inside a longer word does not match', () => {
  doesNotResolve('Ce vinuri recomanzi daca vreau ceva sec');   // "daca" vs alias "DAC"
  doesNotResolve('Novakovici este un nume de familie');        // "Novakovici" vs "Novak"
  doesNotResolve('Tomaiul acesta nu exista');                  // "Tomaiul" vs "Tomai"
});

// ----------------------------------------------- producer names that are also words
// Some Ghid producers are spelled exactly like ordinary wine vocabulary
// ("Aroma"). They stay in the registry but are flagged so free prose does not
// resolve to them — an unresolved query is far cheaper than a wrong entity.
test('producer names that are ordinary words do not fire on generic prose', () => {
  doesNotResolve('Aroma acestui vin este placuta si florala');
  doesNotResolve('Aromele de fructe rosii sunt pronuntate');
});

test('registry integrity: unique entityIds, non-empty aliases', () => {
  const ids = new Set();
  for (const e of registry) {
    assert.ok(e.entityId && e.canonicalName, 'entity missing entityId/canonicalName');
    assert.ok(!ids.has(e.entityId), `duplicate entityId: ${e.entityId}`);
    ids.add(e.entityId);
    assert.ok(Array.isArray(e.aliases) && e.aliases.length > 0, `${e.entityId} has no aliases`);
  }
});

console.log = _log;
let failed = 0;
for (const [name, err] of done) {
  if (err) { failed++; console.log(`FAIL  ${name}\n      ${err.message}`); }
  else console.log(`ok    ${name}`);
}
console.log(`\n${done.length - failed}/${done.length} passed`);
if (failed) process.exit(1);
