'use strict';

/**
 * Entity Resolution Benchmark — 128+ cases
 *
 * Run: node tests/benchmark/entityResolutionBenchmark.js
 *
 * Categories: exact, normalized, ASR, transliteration, typo, partial,
 * short, OOS, garbage, negative, ambiguity, multi-entity, general,
 * context, mixed, nodata.
 */

const { resolveEntity } = require('../../src/knowledge/entityResolver');
const path = require('path');

// ── Test cases ───────────────────────────────────────────────────────────────
//
// expected: RESOLVED | MULTI_ENTITY | NOT_FOUND | OUT_OF_SCOPE | GENERAL_QUERY | AMBIGUOUS
// critical: if true, failure blocks Stage 2 acceptance (false positive = violation)
// context: { activeEntity: 'entityId' | null }

const CASES = [];

function add(category, query, expected, expectedEntity, opts = {}) {
  CASES.push({ category, query, expected, expectedEntity, critical: opts.critical !== false, context: opts.context || null, note: opts.note || '' });
}

// ── 1. Exact canonical (15) ──
add('exact', 'Wine & D', 'RESOLVED', 'wine-md', { note: 'canonical alias' });
add('exact', 'WineMD', 'RESOLVED', 'wine-md');
add('exact', 'Wine MD', 'RESOLVED', 'wine-md');
add('exact', 'Wine.md', 'RESOLVED', 'wine-md');
add('exact', 'Wine&D', 'RESOLVED', 'wine-md');
add('exact', 'ВайнМД', 'RESOLVED', 'wine-md');
add('exact', 'Cricova', 'RESOLVED', 'cricova');
add('exact', 'Purcari', 'RESOLVED', 'purcari');
add('exact', 'Castel Mimi', 'RESOLVED', 'castel-mimi');
add('exact', 'Mileștii Mici', 'RESOLVED', 'mileshtii-mici');
add('exact', 'Fautor', 'RESOLVED', 'fautor');
add('exact', 'Kvint', 'RESOLVED', 'kvint');
add('exact', 'Asconi', 'RESOLVED', 'asconi');
add('exact', 'Basavin', 'RESOLVED', 'basavin');
add('exact', 'Crama Dealul de Aur', 'RESOLVED', 'crama-dealul-de-aur');

// ── 2. Normalized variants (10) ──
add('normalized', 'wine and d', 'RESOLVED', 'wine-md');
add('normalized', 'wine md', 'RESOLVED', 'wine-md');
add('normalized', 'castel mimi', 'RESOLVED', 'castel-mimi');
add('normalized', 'Пуркари', 'RESOLVED', 'purcari');
add('normalized', 'Крикова', 'RESOLVED', 'cricova');
add('normalized', 'cricova', 'RESOLVED', 'cricova');
add('normalized', 'purcari', 'RESOLVED', 'purcari');
add('normalized', 'milestii mici', 'RESOLVED', 'mileshtii-mici');
add('normalized', 'vinuri de comrat', 'RESOLVED', 'vinuri-de-comrat');
add('normalized', 'Квint', 'RESOLVED', 'kvint');

// ── 3. ASR distortion / phonetic (15) — CRITICAL ──
add('asr', 'Y and D', 'RESOLVED', 'wine-md', { note: 'primary ASR failure case' });
add('asr', 'Wine D', 'RESOLVED', 'wine-md', { note: 'dropped ampersand' });
add('asr', 'Y&D', 'RESOLVED', 'wine-md', { note: 'shortened ASR' });
add('asr', 'Y& D', 'RESOLVED', 'wine-md', { note: 'space after &' });
add('asr', 'WineEmDee', 'RESOLVED', 'wine-md', { note: 'phonetic spelling' });
add('asr', 'UineMD', 'RESOLVED', 'wine-md', { note: 'W→U misrecognition' });
add('asr', 'Wine. MD', 'RESOLVED', 'wine-md', { note: 'dot + space' });
add('asr', 'wine em dee', 'RESOLVED', 'wine-md', { note: 'spaced phonetic' });
add('asr', 'WineM D', 'RESOLVED', 'wine-md', { note: 'space alt' });
add('asr', 'WiнеMD', 'RESOLVED', 'wine-md', { note: 'mixed script e→е' });
add('asr', 'Y&DI', 'RESOLVED', 'wine-md', { note: 'ASR variant — Dice 0.89 matches Y& D alias' });
add('asr', 'WnMD', 'RESOLVED', 'wine-md', { note: 'missing letters' });
add('asr', 'Wine n D', 'RESOLVED', 'wine-md', { note: 'n instead of and' });
add('asr', 'WimeMD', 'RESOLVED', 'wine-md', { note: 'single char typo' });
add('asr', 'Wyne&Di', 'RESOLVED', 'wine-md', { note: 'multiple typos' });

// ── 4. Transliteration (10) — CRITICAL ──
add('translit', 'krikova', 'RESOLVED', 'cricova', { note: 'C→K transliteration' });
add('translit', 'Krikowa', 'RESOLVED', 'cricova', { note: 'C→K, va→wa' });
add('translit', 'Krıcova', 'RESOLVED', 'cricova', { note: 'dotless i' });
add('translit', 'Kritsova', 'RESOLVED', 'cricova', { note: 'c→ts' });
add('translit', 'Purkari', 'RESOLVED', 'purcari', { note: 'c→k' });
add('translit', 'Purkary', 'RESOLVED', 'purcari', { note: 'c→k, i→y' });
add('translit', 'Purkari Wineries', 'RESOLVED', 'purcari', { note: 'typo + wineries' });
add('translit', 'Milestii Mici', 'RESOLVED', 'mileshtii-mici', { note: 'no diacritics' });
add('translit', 'Milishtii Mici', 'RESOLVED', 'mileshtii-mici', { note: 'phonetic' });
add('translit', 'Cricova Prestige', 'RESOLVED', 'cricova', { note: 'already aliased' });

// ── 5. Spelling typos (8) ──
add('typo', 'Crikova', 'RESOLVED', 'cricova', { note: 'single char' });
add('typo', 'Criccova', 'RESOLVED', 'cricova', { note: 'double c' });
add('typo', 'Purkary Wines', 'RESOLVED', 'purcari', { note: 'typo + extra word' });
add('typo', 'Castel Mimm', 'RESOLVED', 'castel-mimi', { note: 'double m' });
add('typo', 'Castelli Mimi', 'RESOLVED', 'castel-mimi', { note: 'italianized' });
add('typo', 'Fautor Winery', 'RESOLVED', 'fautor', { note: 'with suffix' });
add('typo', 'Asonci', 'RESOLVED', 'asconi', { note: 'transposed letters' });
add('typo', 'Bravista Winery', 'RESOLVED', 'bravista', { note: 'with suffix' });

// ── 6. Partial / distinctive tokens (3) — explicitly aliased ──
add('partial', 'Château Purcari', 'RESOLVED', 'purcari', { note: 'already in alias list' });
add('partial', 'Purcari Wineries', 'RESOLVED', 'purcari', { note: 'already aliased' });
add('partial', 'Mimi', 'RESOLVED', 'castel-mimi', { critical: false, note: 'partial name, may need alias' });

// ── 7. Short / cryptic (5) ──
add('short', 'WMD', 'RESOLVED', 'wine-md', { critical: false, note: 'acronym' });
add('short', 'W&D', 'RESOLVED', 'wine-md', { critical: false, note: 'compact' });
add('short', 'MD', 'NOT_FOUND', null, { note: 'too short/ambiguous → NOT_FOUND' });
add('short', 'WD', 'NOT_FOUND', null, { note: 'too ambiguous' });
add('short', 'WM', 'NOT_FOUND', null, { note: 'not a known code' });

// ── 8. OOS — outside Moldova wine scope (3)
//     Target state (Stage 2): OUT_OF_SCOPE. Current resolver returns NOT_FOUND.
//     This gap is acceptable baseline behaviour.
add('oos', 'Bordeaux', 'OUT_OF_SCOPE', null, { note: 'region outside scope' });
add('oos', 'Château Margaux', 'OUT_OF_SCOPE', null, { note: 'Bordeaux wine outside scope' });
add('oos', 'Napa Valley', 'OUT_OF_SCOPE', null, { note: 'region outside scope' });

// ── 8b. Grapes — in-scope varieties currently missing from registry (2)
add('unknown-entity', 'Riesling', 'RESOLVED', 'riesling', { note: 'grape variety; add entity in Stage 2' });
add('unknown-entity', 'Chardonnay', 'RESOLVED', 'chardonnay', { note: 'grape variety; add entity in Stage 2' });

// ── 8c. Unregistered but in-scope wineries (2)
add('unknown-entity', 'Et Cetera winery', 'RESOLVED', 'et-cetera', { note: 'real Moldovan winery; add entity in Stage 2' });
add('unknown-entity', 'Vinaria Nobil', 'RESOLVED', 'vinaria-nobil', { note: 'real Moldovan winery; add entity in Stage 2' });

// ── 8d. Fake/ambiguous → NOT_FOUND (2)
add('oos', 'WineXY', 'NOT_FOUND', null, { note: 'plausible but fake' });
add('oos', 'MoldovaWin', 'NOT_FOUND', null, { note: 'plausible but fake' });
add('oos', 'Domenii', 'NOT_FOUND', null, { note: 'too ambiguous for resolution' });

// ── 9. Garbage input (5) — CRITICAL: must NOT resolve ──
add('garbage', 'Lskdjflk', 'NOT_FOUND', null, { note: 'random letters' });
add('garbage', '12345', 'NOT_FOUND', null, { note: 'digits only' });
add('garbage', '!!!', 'NOT_FOUND', null, { note: 'punctuation only' });
add('garbage', '', 'NOT_FOUND', null, { note: 'empty string' });
add('garbage', '   ', 'NOT_FOUND', null, { note: 'whitespace only' });

// ── 10. Negative generic-term cases (10) — CRITICAL: must NOT resolve
//     Generic wine terms that should NOT resolve to wine-md.
//     Currently "Wine" → wine-md (fuzzy threshold false positive).
add('negative', 'Wine', 'NOT_FOUND', null, { critical: true, note: 'generic word; CURRENT FALSE POSITIVE' });
add('negative', 'wines', 'NOT_FOUND', null, { note: 'generic plural' });
add('negative', 'vino', 'NOT_FOUND', null, { note: 'generic RO/ES word' });
add('negative', 'vin', 'NOT_FOUND', null, { note: 'generic FR/RO word' });
add('negative', 'вино', 'NOT_FOUND', null, { note: 'generic RU word' });
add('negative', 'winery', 'NOT_FOUND', null, { note: 'generic type' });
add('negative', 'wine shop', 'NOT_FOUND', null, { note: 'generic place' });
add('negative', 'Moldovan wine', 'NOT_FOUND', null, { note: 'descriptive, not an entity' });
add('negative', 'local wine', 'NOT_FOUND', null, { note: 'generic phrase' });
add('negative', 'red wine', 'NOT_FOUND', null, { note: 'generic category' });

// ── 11. Ambiguity (5) — CRITICAL ──
add('ambiguity', 'Cricova', 'RESOLVED', 'cricova', { note: 'not ambiguous today; placeholder' });
add('ambiguity', 'Divin', 'NOT_FOUND', null, { note: 'unresolved; would be AMBIGUOUS in Stage 2' });
add('ambiguity', 'Kvint', 'RESOLVED', 'kvint', { note: 'not ambiguous; placeholder' });
add('ambiguity', 'Gold', 'NOT_FOUND', null, { note: 'generic; would be AMBIGUOUS in Stage 2' });
add('ambiguity', 'Wine', 'NOT_FOUND', null, { note: 'generic word; covered by negative category' });

// ── 12. Multi-entity (5) ──
add('multi', 'Cricova и Purcari', 'MULTI_ENTITY', ['cricova', 'purcari'], { note: 'two wineries' });
add('multi', 'Purcari and Cricova', 'MULTI_ENTITY', ['purcari', 'cricova'], { note: 'EN conjunction' });
add('multi', 'Castel Mimi и Mileștii Mici', 'MULTI_ENTITY', ['castel-mimi', 'mileshtii-mici'], { note: 'two wineries RU' });
add('multi', 'wine.md & Cricova', 'MULTI_ENTITY', ['wine-md', 'cricova'], { note: 'platform + winery' });
add('multi', 'Purcari и Kvint', 'MULTI_ENTITY', ['purcari', 'kvint'], { note: 'two wineries' });

// ── 13. General query (10) ──
add('general', 'расскажи про молдавское вино', 'GENERAL_QUERY', null);
add('general', 'что такое фетяска нягрэ', 'GENERAL_QUERY', null, { note: 'grape question, not entity' });
add('general', 'best red wine from Moldova', 'GENERAL_QUERY', null);
add('general', 'какие вина самые популярные', 'GENERAL_QUERY', null);
add('general', 'расскажи о молдавском виноделии', 'GENERAL_QUERY', null);
add('general', 'как выбрать вино', 'GENERAL_QUERY', null);
add('general', 'где купить', 'GENERAL_QUERY', null, { note: 'no activeEntity → general' });
add('general', 'сколько стоит экскурсия', 'GENERAL_QUERY', null, { note: 'no activeEntity → general' });
add('general', 'какая температура подачи', 'GENERAL_QUERY', null);
add('general', 'Povestește-mi despre vinurile Moldovei', 'GENERAL_QUERY', null);

// ── 14. Context-dependent (10) ──
// Pipeline input: { query, activeEntity }. The target pipeline checks
// activeEntity BEFORE resolveEntity; current resolver does NOT use context,
// so these cases are GAPs when resolveEntity alone returns NOT_FOUND.
add('context', 'расскажи подробнее', 'RESOLVED', 'cricova', { context: { activeEntity: 'cricova' }, note: 'follow-up with context' });
add('context', 'а что ещё?', 'RESOLVED', 'cricova', { context: { activeEntity: 'cricova' }, note: 'follow-up with context' });
add('context', 'сколько стоит', 'RESOLVED', 'cricova', { context: { activeEntity: 'cricova' }, note: 'price with context' });
add('context', 'где находится', 'RESOLVED', 'cricova', { context: { activeEntity: 'cricova' }, note: 'location with context' });
add('context', 'расскажи подробнее', 'RESOLVED', 'purcari', { context: { activeEntity: 'purcari' }, note: 'follow-up with other entity' });
add('context', 'какие вина производят', 'RESOLVED', 'cricova', { context: { activeEntity: 'cricova' }, note: 'wines with context' });
add('context', 'расписание экскурсий', 'RESOLVED', 'cricova', { context: { activeEntity: 'cricova' }, note: 'tours with context' });
// Without activeEntity (no context)
add('context', 'расскажи подробнее', 'GENERAL_QUERY', null, { note: 'no entity → general' });
add('context', 'а что ещё?', 'GENERAL_QUERY', null, { note: 'follow-up without context → general' });
add('context', 'сколько стоит', 'GENERAL_QUERY', null, { note: 'price without entity → general' });

// ── 15. RU/RO/EN mixed (5) ──
add('mixed', 'Что такое Fetească Neagră', 'GENERAL_QUERY', null);
add('mixed', 'Moldovan wine отзывы', 'GENERAL_QUERY', null);
add('mixed', 'Cricova degustare', 'RESOLVED', 'cricova', { note: 'winery + RO word' });
add('mixed', 'Purcari recenzii', 'RESOLVED', 'purcari', { note: 'winery + RO word' });
add('mixed', 'вино Cricova', 'RESOLVED', 'cricova', { note: 'RU with named entity' });

// ── 16. RESOLVED_NO_DATA (2) ──
add('nodata', 'Wine & D', 'RESOLVED', 'wine-md', { note: 'will have data' });
add('nodata', 'Cricova', 'RESOLVED', 'cricova', { note: 'will have data' });


// ── Pipeline ──

// Baseline pipeline: resolveEntity only (ignores contextEntity — it's not
// implemented yet). Context cases use this same function; they show as GAPs
// because the pipeline would need to check activeEntity before calling
// resolveEntity, but that's Stage 2.
function baselineResolve(input, options = {}) {
  const { contextEntity, ...rest } = options;
  return resolveEntity(input, rest);
}


// ── Classification ──

function classifyResult(c, r) {
  const expected = c.expected;
  const context = c.context;
  const expectedEntity = c.expectedEntity;
  const activeEntity = context ? context.activeEntity : null;

  // ── RESOLVED ──
  if (expected === 'RESOLVED') {
    if (!r.found) {
      // If context is set, the target pipeline would resolve via context
      if (activeEntity) {
        console.log(`GAP    ["${c.query}"] → NOT_FOUND (ctx:${activeEntity}, expected ${expectedEntity}) — ${c.note}`);
        return 'GAP';
      }
      console.log(`GAP!   ["${c.query}"] → NOT_FOUND (expected ${expectedEntity}) — ${c.note}`);
      return 'GAP';
    }
    if (r.entityId !== expectedEntity) {
      console.log(`FAIL   ["${c.query}"] → ${r.entityId} (expected ${expectedEntity}) — wrong entity`);
      return 'FAIL';
    }
    console.log(`OK     ["${c.query}"] → ${r.entityId} (${r.matchType}, conf=${r.confidence})`);
    return 'PASS';
  }

  // ── MULTI_ENTITY ──
  if (expected === 'MULTI_ENTITY') {
    if (!r.found) {
      console.log(`GAP!   ["${c.query}"] → NOT_FOUND (expected MULTI: ${expectedEntity.join(',')})`);
      return 'GAP';
    }
    if (!r.allMentions || r.allMentions.length < 2) {
      console.log(`GAP!   ["${c.query}"] → single entity only (expected MULTI: ${expectedEntity.join(',')})`);
      return 'GAP';
    }
    const foundIds = r.allMentions.map(m => m.entityId);
    const allFound = expectedEntity.every(eid => foundIds.includes(eid));
    if (!allFound) {
      console.log(`GAP!   ["${c.query}"] → ${foundIds.join(',')} (expected MULTI: ${expectedEntity.join(',')})`);
      return 'GAP';
    }
    console.log(`OK     ["${c.query}"] → ${r.allMentions.map(m => m.entityId).join(', ')} (MULTI)`);
    return 'PASS';
  }

  // ── NOT_FOUND — entity should NOT resolve ──
  if (expected === 'NOT_FOUND') {
    if (!r.found) {
      console.log(`OK     ["${c.query}"] → NOT_FOUND (expected)`);
      return 'PASS';
    }
    console.log(`FAIL   ["${c.query}"] → ${r.entityId} (expected NOT_FOUND) — false positive!`);
    return 'FAIL';
  }

  // ── OUT_OF_SCOPE — target state is OOS, but current resolver returns
  //     NOT_FOUND. This is a baseline gap, not a pass or fail.
  if (expected === 'OUT_OF_SCOPE') {
    if (!r.found) {
      console.log(`GAP*   ["${c.query}"] → NOT_FOUND (expected OUT_OF_SCOPE) — baseline gap, not a pass`);
      return 'BASELINE_GAP';
    }
    console.log(`FAIL   ["${c.query}"] → ${r.entityId} (expected OUT_OF_SCOPE) — false positive!`);
    return 'FAIL';
  }

  // ── GENERAL_QUERY — not an entity query ──
  if (expected === 'GENERAL_QUERY') {
    if (!r.found) {
      console.log(`OK     ["${c.query}"] → NOT_FOUND (general query)`);
      return 'PASS';
    }
    // Accept mention extraction for mixed queries containing an entity name
    if (r.matchType === 'mention_extract' && activeEntity) {
      console.log(`OK     ["${c.query}"] → ${r.entityId} (mention extract, context)`);
      return 'PASS';
    }
    console.log(`GAP    ["${c.query}"] → ${r.entityId} (expected GENERAL, resolved)`);
    return 'GAP';
  }

  // ── AMBIGUOUS — Stage 2 ──
  if (expected === 'AMBIGUOUS') {
    console.log(`SKIP   ["${c.query}"] (${expected} — Stage 2)`);
    return 'SKIP';
  }

  return 'FAIL';
}


// ── Run ──

async function run() {
  console.log(`\n${'='.repeat(80)}`);
  console.log('ENTITY RESOLUTION BENCHMARK — REFINED BASELINE');
  console.log(`${'='.repeat(80)}\n`);

  let results = [];

  for (const c of CASES) {
    const r = baselineResolve(c.query, c.context ? { contextEntity: c.context.activeEntity } : {});
    const status = classifyResult(c, r);
    results.push({ ...c, status, actual: r });
  }

  // ── Aggregate ──
  const pass  = results.filter(r => r.status === 'PASS').length;
  const fail  = results.filter(r => r.status === 'FAIL').length;
  const gap   = results.filter(r => r.status === 'GAP').length;
  const bgap  = results.filter(r => r.status === 'BASELINE_GAP').length;
  const skip  = results.filter(r => r.status === 'SKIP').length;
  const total = results.length;
  const activeTotal = total - skip;

  // ── TP / FP / FN / TN ──
  // TP = expected RESOLVED/MULTI and matched correctly
  // FP = resolved when should NOT resolve (expected NOT_FOUND/OOS/GENERAL/AMBIGUOUS)
  // FN = expected RESOLVED/MULTI but got NOT_FOUND (GAP)
  // TN = expected NOT_FOUND/GENERAL and got NOT_FOUND
  // BASELINE_GAP = expected OUT_OF_SCOPE but got NOT_FOUND (acceptable baseline limitation)
  let tp = 0, fp = 0, fn = 0, tn = 0, bgapNum = 0;

  for (const r of results) {
    if (r.status === 'PASS') {
      if (r.expected === 'RESOLVED' || r.expected === 'MULTI_ENTITY') tp++;
      else tn++;
    } else if (r.status === 'FAIL') {
      fp++;
    } else if (r.status === 'GAP') {
      if (r.expected === 'RESOLVED' || r.expected === 'MULTI_ENTITY') fn++;
      else tn++; // GAP for GENERAL_QUERY that resolved — still, expected was non-entity
    } else if (r.status === 'BASELINE_GAP') {
      bgapNum++;
    }
  }

  const precision = tp + fp > 0 ? (tp / (tp + fp) * 100).toFixed(1) : 'N/A';
  const recall    = tp + fn > 0 ? (tp / (tp + fn) * 100).toFixed(1) : 'N/A';
  const f1_num    = tp + fp > 0 && tp + fn > 0 ? (2 * tp / (2 * tp + fp + fn)) : 0;
  const f1        = (f1_num * 100).toFixed(1);

  // ── Summary table ──
  console.log(`\n${'='.repeat(80)}`);
  console.log('SUMMARY');
  console.log(`${'='.repeat(80)}`);
  console.log(`Total cases:     ${total}`);
  console.log(`Active (no skip): ${activeTotal}`);
  console.log(`Pass:            ${pass}`);
  console.log(`Fail:            ${fail}`);
  console.log(`Gap:             ${gap}`);
  console.log(`Baseline gap*:   ${bgap}  (* OOS expected, NOT_FOUND actual — target is OUT_OF_SCOPE)`);
  console.log(`Skip:            ${skip}`);
  console.log(`Rate:            ${(pass / activeTotal * 100).toFixed(1)}%`);
  console.log(``);
  console.log(`True Positives:  ${tp}`);
  console.log(`False Positives: ${fp}`);
  console.log(`False Negatives: ${fn}`);
  console.log(`True Negatives:  ${tn}`);
  console.log(`Baseline gaps:   ${bgapNum}`);
  console.log(``);
  console.log(`Precision:       ${precision}%`);
  console.log(`Recall:          ${recall}%`);
  console.log(`F1:              ${f1}%`);

  // ── Confusion matrix ──
  console.log(`\n--- Confusion Matrix (expected vs actual, count) ---`);
  const states = ['RESOLVED', 'NOT_FOUND', 'OUT_OF_SCOPE', 'GENERAL_QUERY', 'MULTI_ENTITY'];
  const colLabels = ['RESOLVED', 'NOT_FOUND', 'MULTI', 'OOS_GAP'];
  console.log(`  ${'Expected \\ Actual'.padEnd(16)} ${colLabels.map(c => c.padStart(10)).join(' ')}`);

  for (const expState of states) {
    const rowCases = results.filter(r => r.expected === expState && r.status !== 'SKIP');
    const nfPassed = rowCases.filter(r => r.status === 'PASS').length;
    const nfGapResolved = rowCases.filter(r => r.status === 'GAP').length;

    let rVal, nfVal, mVal, oVal;
    if (expState === 'RESOLVED') {
      rVal = rowCases.filter(r => r.status === 'PASS').length;
      nfVal = nfGapResolved;
      mVal = '-'; oVal = '-';
    } else if (expState === 'NOT_FOUND') {
      rVal = rowCases.filter(r => r.status === 'FAIL').length;
      nfVal = nfPassed;
      mVal = '-'; oVal = '-';
    } else if (expState === 'OUT_OF_SCOPE') {
      rVal = rowCases.filter(r => r.status === 'FAIL').length;
      nfVal = '-'; mVal = '-';
      oVal = rowCases.filter(r => r.status === 'BASELINE_GAP').length;
    } else if (expState === 'GENERAL_QUERY') {
      rVal = nfGapResolved;
      nfVal = nfPassed;
      mVal = '-'; oVal = '-';
    } else if (expState === 'MULTI_ENTITY') {
      rVal = '-';
      nfVal = nfGapResolved;
      mVal = nfPassed;
      oVal = '-';
    }
    console.log(`  ${expState.padEnd(16)} ${String(rVal).padStart(10)} ${String(nfVal).padStart(10)} ${String(mVal).padStart(10)} ${String(oVal).padStart(10)}`);
  }

  // ── FAIL list ──
  const fails = results.filter(r => r.status === 'FAIL');
  console.log(`\n--- FAIL (${fails.length}) ---`);
  for (const r of fails) {
    console.log(`  [${r.category}] "${r.query}" → ${formatActual(r.actual)} (expected ${r.expected}${r.expectedEntity ? ': ' + r.expectedEntity : ''})`);
  }

  // ── GAP breakdown ──
  const gaps = results.filter(r => r.status === 'GAP');
  console.log(`\n--- GAP (${gaps.length}) by expected state ---`);
  const gapByState = {};
  for (const r of gaps) {
    const key = `${r.expected}${r.expectedEntity ? ' → ' + r.expectedEntity : ''}`;
    if (!gapByState[key]) gapByState[key] = [];
    gapByState[key].push(r);
  }
  for (const [state, items] of Object.entries(gapByState)) {
    console.log(`\n  Expected ${state}:`);
    for (const r of items) {
      console.log(`    [${r.category}] "${r.query}" → ${formatActual(r.actual)} — ${r.note}`);
    }
  }

  // ── Baseline gaps (OOS→NOT_FOUND) ──
  const baselineGaps = results.filter(r => r.status === 'BASELINE_GAP');
  console.log(`\n--- BASELINE GAP* (${baselineGaps.length}) — OOS expected, NOT_FOUND actual ---`);
  for (const r of baselineGaps) {
    console.log(`    [${r.category}] "${r.query}" → NOT_FOUND (target: OUT_OF_SCOPE)`);
  }

  // ── Category metrics ──
  console.log(`\n--- By category ---`);
  const byCat = {};
  for (const r of results) {
    if (!byCat[r.category]) byCat[r.category] = { total: 0, pass: 0, fail: 0, gap: 0, bgap: 0 };
    byCat[r.category].total++;
    const key = r.status === 'BASELINE_GAP' ? 'bgap' : r.status.toLowerCase();
    byCat[r.category][key]++;
  }
  console.log(`  ${'Category'.padEnd(14)} ${'Pass'.padStart(5)}/${'Total'.padStart(5)}  Fail  Gap  BGap`);
  for (const [cat, stats] of Object.entries(byCat)) {
    console.log(`  ${cat.padEnd(14)} ${String(stats.pass).padStart(5)}/${String(stats.total).padStart(5)}  ${String(stats.fail).padStart(4)} ${String(stats.gap).padStart(4)} ${String(stats.bgap).padStart(4)}`);
  }

  // ── False positives detail ──
  // FP = expected NOT_FOUND/OOS/GENERAL but entity resolved
  const fpList = results.filter(r => r.status === 'FAIL' && r.actual.found &&
    r.expected !== 'RESOLVED' && r.expected !== 'MULTI_ENTITY');

  const oosFp = fpList.filter(r => r.expected === 'OUT_OF_SCOPE');
  const otherFp = fpList.filter(r => r.expected !== 'OUT_OF_SCOPE');

  console.log(`\n--- FALSE POSITIVES ---`);
  console.log(`  Total FP: ${fpList.length}`);
  console.log(`  OOS/garbage FP: ${oosFp.length} ${oosFp.length === 0 ? '✅' : '❌'}`);
  console.log(`  Other FP: ${otherFp.length}`);
  for (const r of fpList) {
    console.log(`    [${r.category}] "${r.query}" → ${r.actual.entityId} (${r.actual.matchType}, conf=${r.actual.confidence})`);
  }

  // ── Save baseline ──
  const fs = require('fs');
  const baseline = {
    date: new Date().toISOString(),
    commit: require('child_process').execSync('git rev-parse HEAD').toString().trim(),
    total, pass, fail, gap, bgap, skip, activeTotal,
    tp, fp, fn, tn, bgapNum,
    precision: parseFloat(precision),
    recall: parseFloat(recall),
    f1: parseFloat(f1),
    results: results.map(r => ({
      category: r.category, query: r.query,
      expected: r.expected, expectedEntity: r.expectedEntity,
      critical: r.critical, context: r.context,
      status: r.status,
      actualFound: r.actual.found,
      actualEntity: r.actual.found ? r.actual.entityId : null,
      actualConfidence: r.actual.found ? r.actual.confidence : 0,
      actualMatchType: r.actual.found ? r.actual.matchType : null,
    })),
  };
  const outPath = path.join(__dirname, 'entity-benchmark-baseline.json');
  fs.writeFileSync(outPath, JSON.stringify(baseline, null, 2));
  console.log(`\nBaseline saved to ${outPath}`);

  if (fails.length > 0) process.exit(1);
}

function formatActual(r) {
  if (!r || !r.found) return 'NOT_FOUND';
  return `${r.entityId} (${r.matchType}, conf=${r.confidence})`;
}

run().catch(e => { console.error(e); process.exit(1); });
