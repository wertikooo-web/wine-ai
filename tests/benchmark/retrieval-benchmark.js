'use strict';

/**
 * Phase 3 — Retrieval Relevance Benchmark
 *
 * Validates: entity correctness, top-1/top-3 content match, entity contamination,
 * cross-language evidence, multi-entity, unknown entity no-result, grounded answer.
 *
 * Usage: node tests/benchmark/retrieval-benchmark.js [--json]
 */

const { search } = require('../../src/knowledge/search');
const { resolveEntity, resolveEntities } = require('../../src/knowledge/entityResolver');
const { loadIndex } = require('../../src/knowledge/index');

const JSON_OUTPUT = process.argv.includes('--json');

// ─── Benchmark Queries ───────────────────────────────────────────────
// Each query has:
//   q: query text
//   cat: category
//   expect: validation expectations
//     entity: true/false — entity should resolve
//     entityId: expected entity ID
//     mode: expected search mode
//     top1Contains: text that MUST appear in top-1 chunk (case-insensitive)
//     top3Contains: text that MUST appear in at least one of top-3 chunks
//     falsePositive: true if this should NOT match any entity
//     noResult: true if search should return 0 hits
//     multiEntity: array of entity IDs that should ALL be resolved
//     relevantTopics: keywords that should appear in results

const QUERIES = [
  // ═══ Category 1: WineMD Entity (exact aliases) ═══
  { q: 'WineMD', cat: 'entity-exact', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Wine & D', cat: 'entity-exact', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'wine.md', cat: 'entity-exact', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'ВайнМД', cat: 'entity-exact', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Wine&D', cat: 'entity-exact', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Wine MD', cat: 'entity-exact', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Wine.md', cat: 'entity-exact', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Вайн МД', cat: 'entity-exact', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Вайн.МД', cat: 'entity-exact', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },

  // ═══ Category 2: New Entity — Major Wineries ═══
  { q: 'Purcari', cat: 'entity-new', expect: { entity: true, entityId: 'purcari', mode: 'entity', top1Contains: 'Purcari' } },
  { q: 'Cricova', cat: 'entity-new', expect: { entity: true, entityId: 'cricova', mode: 'entity', top1Contains: 'Cricova' } },
  { q: 'Mileștii Mici', cat: 'entity-new', expect: { entity: true, entityId: 'mileshtii-mici', mode: 'entity' } },
  { q: 'Castel Mimi', cat: 'entity-new', expect: { entity: true, entityId: 'castel-mimi', mode: 'entity' } },
  { q: 'Fautor', cat: 'entity-new', expect: { entity: true, entityId: 'fautor', mode: 'entity' } },
  { q: 'Gitana', cat: 'entity-new', expect: { entity: true, entityId: 'gitana', mode: 'entity' } },
  { q: 'Kvint', cat: 'entity-new', expect: { entity: true, entityId: 'kvint', mode: 'entity' } },
  { q: 'Vinuri de Comrat', cat: 'entity-new', expect: { entity: true, entityId: 'vinuri-de-comrat', mode: 'entity' } },
  { q: 'Novak', cat: 'entity-new', expect: { entity: true, entityId: 'novak', mode: 'entity' } },
  { q: 'Asconi', cat: 'entity-new', expect: { entity: true, entityId: 'asconi', mode: 'entity' } },

  // ═══ Category 3: Entity in Natural Language ═══
  { q: 'Расскажи про Purcari', cat: 'entity-nl', expect: { entity: true, entityId: 'purcari', mode: 'entity' } },
  { q: 'Где находится Cricova?', cat: 'entity-nl', expect: { entity: true, entityId: 'cricova', mode: 'entity' } },
  { q: 'Tell me about WineMD', cat: 'entity-nl', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Where is WineMD located?', cat: 'entity-nl', expect: { entity: true, entityId: 'wine-md', mode: 'entity', top1Contains: 'адрес' } },
  { q: 'Ce este Wine.md?', cat: 'entity-nl', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Вина Cricova', cat: 'entity-nl', expect: { entity: true, entityId: 'cricova', mode: 'entity' } },
  { q: 'Mileștii Mici винный погреб', cat: 'entity-nl', expect: { entity: true, entityId: 'mileshtii-mici', mode: 'entity' } },
  { q: 'Kvint коньяк', cat: 'entity-nl', expect: { entity: true, entityId: 'kvint', mode: 'entity' } },

  // ═══ Category 4: Entity Fuzzy ═══
  { q: 'Wine Md', cat: 'entity-fuzzy', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'winemd', cat: 'entity-fuzzy', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'wine md', cat: 'entity-fuzzy', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'wine and d', cat: 'entity-fuzzy', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },

  // ═══ Category 5: Unknown Entity → entity not resolved ═══
  { q: 'Domaine du Marquis', cat: 'unknown-entity', expect: { entity: false } },
  { q: 'Château Margaux', cat: 'unknown-entity', expect: { entity: false } },
  { q: 'Винодельня Новый Свет', cat: 'unknown-entity', expect: { entity: false } },
  { q: 'Barolo.it', cat: 'unknown-entity', expect: { entity: false } },

  // ═══ Category 6: Multi-Entity ═══
  { q: 'Purcari и Cricova', cat: 'multi-entity', expect: { multiEntity: ['purcari', 'cricova'] } },
  { q: 'Сравни Purcari и Mileștii Mici', cat: 'multi-entity', expect: { multiEntity: ['purcari', 'mileshtii-mici'] } },

  // ═══ Category 7: General Wine Knowledge (RU) ═══
  { q: 'Что такое ферментация вина?', cat: 'general-ru', expect: { entity: false } },
  { q: 'Какие сорта винограда растут в Молдове?', cat: 'general-ru', expect: { entity: false, relevantTopics: ['сорта', 'виноград', 'Молдова'] } },
  { q: 'Чем отличается красное вино от белого?', cat: 'general-ru', expect: { entity: false, relevantTopics: ['красное', 'белое'] } },
  { q: 'Как правильно дегустировать вино?', cat: 'general-ru', expect: { entity: false } },
  { q: 'Что такое танины в вине?', cat: 'general-ru', expect: { entity: false, relevantTopics: ['танины'] } },
  { q: 'Как хранить вино дома?', cat: 'general-ru', expect: { entity: false } },
  { q: 'Что такое купажирование вина?', cat: 'general-ru', expect: { entity: false } },
  { q: 'Как читать этикетку вина?', cat: 'general-ru', expect: { entity: false } },
  { q: 'Что такое апелласьон в виноделии?', cat: 'general-ru', expect: { entity: false } },
  { q: 'Как производят шампанское?', cat: 'general-ru', expect: { entity: false } },

  // ═══ Category 8: General Wine Knowledge (EN) ═══
  { q: 'What is wine fermentation?', cat: 'general-en', expect: { entity: false, relevantTopics: ['fermentation'] } },
  { q: 'How to taste wine properly?', cat: 'general-en', expect: { entity: false } },
  { q: 'What are tannins in wine?', cat: 'general-en', expect: { entity: false, relevantTopics: ['tannins'] } },
  { q: 'Red vs white wine differences', cat: 'general-en', expect: { entity: false } },
  { q: 'Wine regions of Moldova', cat: 'general-en', expect: { entity: false, relevantTopics: ['Moldova', 'region'] } },
  { q: 'Best Moldovan wines', cat: 'general-en', expect: { entity: false, relevantTopics: ['Moldova'] } },
  { q: 'What is orange wine?', cat: 'general-en', expect: { entity: false } },
  { q: 'How to store wine at home?', cat: 'general-en', expect: { entity: false } },

  // ═══ Category 9: General Wine Knowledge (RO) ═══
  { q: 'Ce este fermentarea vinului?', cat: 'general-ro', expect: { entity: false } },
  { q: 'Cum se degustă vinul corect?', cat: 'general-ro', expect: { entity: false } },
  { q: 'Ce sunt taninii în vin?', cat: 'general-ro', expect: { entity: false } },
  { q: 'Regiunile viticole din Moldova', cat: 'general-ro', expect: { entity: false } },
  { q: 'Cele mai bune vinuri moldovenești', cat: 'general-ro', expect: { entity: false } },

  // ═══ Category 10: Grape Varieties ═══
  { q: 'Фетяска Нягрэ', cat: 'grape', expect: { entity: false, relevantTopics: ['Fetească', 'Neagră'] } },
  { q: 'Fetească Neagră', cat: 'grape', expect: { entity: false, relevantTopics: ['Fetească'] } },
  { q: 'Каберне Совиньон', cat: 'grape', expect: { entity: false, relevantTopics: ['Каберне', 'Совиньон'] } },
  { q: 'Рислинг', cat: 'grape', expect: { entity: false } },
  { q: 'Сира шираз', cat: 'grape', expect: { entity: false } },
  { q: 'Шардоне', cat: 'grape', expect: { entity: false } },

  // ═══ Category 11: Regions ═══
  { q: 'Винодельческий регион Кодру', cat: 'region', expect: { entity: false, relevantTopics: ['Кодру'] } },
  { q: 'Штефан Водэ вино', cat: 'region', expect: { entity: false } },
  { q: 'Purcari регион', cat: 'region', expect: { entity: true, entityId: 'purcari', relevantTopics: ['Purcari'] } },
  { q: 'Valul lui Traian', cat: 'region', expect: { entity: false } },

  // ═══ Category 12: Food Pairing ═══
  { q: 'С чем подавать красное вино?', cat: 'pairing', expect: { entity: false } },
  { q: 'Wine and cheese pairing', cat: 'pairing', expect: { entity: false } },
  { q: 'Вино к мясу', cat: 'pairing', expect: { entity: false } },
  { q: 'What wine goes with fish?', cat: 'pairing', expect: { entity: false } },

  // ═══ Category 13: Recommendations ═══
  { q: 'Посоветуй вино для подарка', cat: 'recommendation', expect: { entity: false } },
  { q: 'Recommend a dry red wine', cat: 'recommendation', expect: { entity: false } },
  { q: 'Какое вино выбрать для ужина?', cat: 'recommendation', expect: { entity: false } },
  { q: 'Best budget Moldovan wine', cat: 'recommendation', expect: { entity: false } },

  // ═══ Category 14: Wine Production ═══
  { q: 'Как делают вино?', cat: 'production', expect: { entity: false } },
  { q: 'Виноделие в Молдове', cat: 'production', expect: { entity: false, relevantTopics: ['Молдова'] } },
  { q: 'Organic wine production', cat: 'production', expect: { entity: false } },

  // ═══ Category 15: Events ═══
  { q: 'Decanter World Wine Awards 2026', cat: 'events', expect: { entity: false } },
  { q: 'ProWein 2024', cat: 'events', expect: { entity: false } },
  { q: 'Mundus Vini', cat: 'events', expect: { entity: false } },

  // ═══ Category 16: Wine Tourism ═══
  { q: 'Винный туризм в Молдове', cat: 'tourism', expect: { entity: false, relevantTopics: ['Молдова', 'туризм'] } },
  { q: 'Wine route Chisinau', cat: 'tourism', expect: { entity: false } },
  { q: 'Дегустационный зал Кишинёв', cat: 'tourism', expect: { entity: false } },

  // ═══ Category 17: Cross-Language (FR) ═══
  { q: 'Où se trouve le domaine viticole Cricova?', cat: 'cross-fr', expect: { entity: true, entityId: 'cricova' } },
  { q: 'Quelles sont les variétés de raisin utilisées en Moldavie?', cat: 'cross-fr', expect: { entity: false } },
  { q: 'Quel vin recommandez-vous pour un dîner?', cat: 'cross-fr', expect: { entity: false } },
  { q: 'Vin moldave Fetească Neagră', cat: 'cross-fr', expect: { entity: false } },

  // ═══ Category 18: Cross-Language (DE) ═══
  { q: 'Wo befindet sich das Weingut Cricova?', cat: 'cross-de', expect: { entity: true, entityId: 'cricova' } },
  { q: 'Welche Traubensorten wachsen in Moldawien?', cat: 'cross-de', expect: { entity: false } },
  { q: 'Welchen Wein empfehlen Sie zum Abendessen?', cat: 'cross-de', expect: { entity: false } },
  { q: 'Moldawischer Wein Fetească Neagră', cat: 'cross-de', expect: { entity: false } },

  // ═══ Category 19: Cross-Language (IT) ═══
  { q: 'Si trova la cantina Cricova?', cat: 'cross-it', expect: { entity: true, entityId: 'cricova' } },
  { q: 'Quali varietà di uva crescono in Moldavia?', cat: 'cross-it', expect: { entity: false } },
  { q: 'Vino moldavo Fetească Neagră', cat: 'cross-it', expect: { entity: false } },

  // ═══ Category 20: Cross-Language (ES) ═══
  { q: 'Dónde se encuentra la bodega Cricova?', cat: 'cross-es', expect: { entity: true, entityId: 'cricova' } },
  { q: '¿Qué variedades de uva crecen en Moldavia?', cat: 'cross-es', expect: { entity: false } },
  { q: 'Vino moldavo Fetească Neagră', cat: 'cross-es', expect: { entity: false } },

  // ═══ Category 21: Cross-Language (UK) ═══
  { q: 'Де знаходиться виноградня Cricova?', cat: 'cross-uk', expect: { entity: true, entityId: 'cricova' } },
  { q: 'Які сорти винограду ростуть у Молдові?', cat: 'cross-uk', expect: { entity: false } },
  { q: 'Молдавське вино Fetească Neagră', cat: 'cross-uk', expect: { entity: false } },

  // ═══ Category 22: Cross-Language (PL) ═══
  { q: 'Gdzie znajduje się winnica Cricova?', cat: 'cross-pl', expect: { entity: true, entityId: 'cricova' } },
  { q: 'Jakie odmiany winogron rosną w Mołdawii?', cat: 'cross-pl', expect: { entity: false } },
  { q: 'Mołdawskie wino Fetească Neagră', cat: 'cross-pl', expect: { entity: false } },

  // ═══ Category 23: Cross-Language Entity ═══
  { q: 'Où se trouve WineMD?', cat: 'cross-entity', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Wo ist WineMD?', cat: 'cross-entity', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Dove si trova WineMD?', cat: 'cross-entity', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Де знаходиться WineMD?', cat: 'cross-entity', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Gdzie jest WineMD?', cat: 'cross-entity', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },

  // ═══ Category 24: Mixed-Language ═══
  { q: 'Wine MD地址在哪里', cat: 'cross-mixed', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Où est le siège de Wine & D?', cat: 'cross-mixed', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Cricova виноградня адрес', cat: 'cross-mixed', expect: { entity: true, entityId: 'cricova' } },

  // ═══ Category 25: Ambiguous / Edge ═══
  { q: 'Что это вообще такое?', cat: 'ambiguous', expect: { entity: false } },
  { q: 'расскажи про этот магазин', cat: 'ambiguous', expect: { entity: false } },
  { q: 'Привет', cat: 'ambiguous', expect: { entity: false } },
  { q: 'Hello', cat: 'ambiguous', expect: { entity: false } },
  { q: 'Автомобиль', cat: 'edge', expect: { entity: false } },
  { q: 'Погода сегодня', cat: 'edge', expect: { entity: false } },
  { q: '', cat: 'edge', expect: { entity: false, noResult: true } },
  { q: 'a', cat: 'edge', expect: { entity: false, noResult: true } },
];

// ─── Validation ──────────────────────────────────────────────────────

function validateResult(query, searchResult, entityResult, expect) {
  const issues = [];

  // Entity resolution
  if (expect.entity !== undefined && entityResult.found !== expect.entity) {
    issues.push(`entity expected=${expect.entity} got=${entityResult.found}`);
  }
  if (expect.entityId && entityResult.entityId !== expect.entityId) {
    issues.push(`entityId expected=${expect.entityId} got=${entityResult.entityId}`);
  }
  if (expect.falsePositive && entityResult.found) {
    issues.push(`FALSE POSITIVE: resolved to ${entityResult.entityId}`);
  }

  // Mode
  if (expect.mode && searchResult.mode !== expect.mode) {
    issues.push(`mode expected=${expect.mode} got=${searchResult.mode}`);
  }

  // No result expectation
  if (expect.noResult && searchResult.hits.length > 0) {
    issues.push(`expected no results but got ${searchResult.hits.length}`);
  }

  // Top-1 content match
  if (expect.top1Contains && searchResult.hits.length > 0) {
    const topText = searchResult.hits[0].chunk.text.toLowerCase();
    if (!topText.includes(expect.top1Contains.toLowerCase())) {
      issues.push(`top-1 missing "${expect.top1Contains}"`);
    }
  }

  // Top-3 content match
  if (expect.top3Contains && searchResult.hits.length > 0) {
    const top3Texts = searchResult.hits.slice(0, 3).map((h) => h.chunk.text.toLowerCase());
    const found = top3Texts.some((t) => t.includes(expect.top3Contains.toLowerCase()));
    if (!found) {
      issues.push(`top-3 missing "${expect.top3Contains}"`);
    }
  }

  // Multi-entity
  if (expect.multiEntity) {
    const resolvedIds = [];
    if (entityResult.found) resolvedIds.push(entityResult.entityId);
    if (entityResult.allMentions) {
      for (const m of entityResult.allMentions) {
        if (!resolvedIds.includes(m.entityId)) resolvedIds.push(m.entityId);
      }
    }
    for (const expectedId of expect.multiEntity) {
      if (!resolvedIds.includes(expectedId)) {
        issues.push(`multi-entity missing ${expectedId}`);
      }
    }
  }

  // Relevant topics (check if any top-5 chunk contains any expected topic)
  if (expect.relevantTopics && searchResult.hits.length > 0) {
    const allText = searchResult.hits.slice(0, 5).map((h) => h.chunk.text.toLowerCase()).join(' ');
    for (const topic of expect.relevantTopics) {
      if (!allText.includes(topic.toLowerCase())) {
        issues.push(`topic "${topic}" not found in top-5 results`);
      }
    }
  }

  return issues;
}

// ─── Benchmark Runner ────────────────────────────────────────────────

async function runBenchmark() {
  const index = loadIndex();
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  Phase 3 — Retrieval Relevance Benchmark`);
  console.log(`${'='.repeat(80)}`);
  console.log(`  Index: ${index.chunks.length} chunks, ${index.chunks.filter((c) => c.metadata.entity_id).length} entity-tagged`);
  console.log(`  Queries: ${QUERIES.length}`);
  console.log(`${'='.repeat(80)}\n`);

  const results = [];
  const categoryStats = {};
  let totalSearchMs = 0;
  let entityMatchCount = 0;
  let falsePositiveCount = 0;
  let emptyResultCount = 0;

  for (let i = 0; i < QUERIES.length; i++) {
    const { q, cat, expect } = QUERIES[i];
    const startTime = Date.now();

    const entityResult = resolveEntity(q);
    const searchResult = await search(q, { limit: 5 });
    const searchMs = Date.now() - startTime;

    const issues = validateResult(q, searchResult, entityResult, expect);

    if (expect.falsePositive && entityResult.found) falsePositiveCount++;
    if (searchResult.hits.length === 0) emptyResultCount++;
    if (entityResult.found) entityMatchCount++;

    const diag = {
      query: q,
      category: cat,
      entityResolved: entityResult.found,
      entityId: entityResult.entityId,
      matchType: entityResult.matchType,
      confidence: entityResult.confidence,
      mode: searchResult.mode,
      hitCount: searchResult.hits.length,
      searchMs,
      tookMs: searchResult.tookMs,
      topHits: searchResult.hits.slice(0, 3).map((h, idx) => ({
        rank: idx + 1,
        chunkId: h.chunk.id,
        title: h.chunk.metadata.title,
        score: Math.round(h.score * 100) / 100,
        entity_id: h.chunk.metadata.entity_id,
        language: h.chunk.metadata.language,
        textPreview: h.chunk.text.slice(0, 120),
      })),
      issues,
      passed: issues.length === 0,
    };

    results.push(diag);
    totalSearchMs += searchMs;

    if (!categoryStats[cat]) categoryStats[cat] = { total: 0, passed: 0, entityMatches: 0, avgMs: 0, totalMs: 0 };
    categoryStats[cat].total++;
    if (issues.length === 0) categoryStats[cat].passed++;
    if (entityResult.found) categoryStats[cat].entityMatches++;
    categoryStats[cat].totalMs += searchMs;

    if ((i + 1) % 20 === 0 || i === QUERIES.length - 1) {
      process.stderr.write(`  Progress: ${i + 1}/${QUERIES.length}\r`);
    }
  }

  for (const cat of Object.keys(categoryStats)) {
    categoryStats[cat].avgMs = Math.round(categoryStats[cat].totalMs / categoryStats[cat].total);
  }

  const passedCount = results.filter((r) => r.passed).length;
  const avgSearchMs = Math.round(totalSearchMs / results.length);

  const report = {
    summary: {
      totalQueries: results.length,
      passed: passedCount,
      failed: results.length - passedCount,
      passRate: Math.round(passedCount / results.length * 100) + '%',
      entityMatchCount,
      falsePositiveCount,
      emptyResultCount,
      avgSearchMs,
    },
    categoryStats,
    failures: results.filter((r) => !r.passed),
  };

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  return report;
}

function printReport(report) {
  const { summary, categoryStats, failures } = report;

  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  SUMMARY`);
  console.log(`${'─'.repeat(80)}`);
  console.log(`  Total queries:      ${summary.totalQueries}`);
  console.log(`  Passed:             ${summary.passed} (${summary.passRate})`);
  console.log(`  Failed:             ${summary.failed}`);
  console.log(`  Entity matches:     ${summary.entityMatchCount}`);
  console.log(`  False positives:    ${summary.falsePositiveCount}`);
  console.log(`  Empty results:      ${summary.emptyResultCount}`);
  console.log(`  Avg search time:    ${summary.avgSearchMs}ms`);

  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  CATEGORY BREAKDOWN`);
  console.log(`${'─'.repeat(80)}`);
  for (const [cat, stats] of Object.entries(categoryStats)) {
    const passRate = Math.round(stats.passed / stats.total * 100);
    console.log(`  ${cat.padEnd(20)} ${String(stats.passed).padStart(3)}/${String(stats.total).padStart(3)} passed (${passRate}%) | entity: ${stats.entityMatches} | avg: ${stats.avgMs}ms`);
  }

  if (failures.length > 0) {
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`  FAILURES (${failures.length})`);
    console.log(`${'─'.repeat(80)}`);
    for (const f of failures) {
      console.log(`\n  FAIL "${f.query}" [${f.category}]`);
      for (const issue of f.issues) {
        console.log(`     -> ${issue}`);
      }
      if (f.topHits.length > 0) {
        console.log(`     top-1: score=${f.topHits[0].score} entity=${f.topHits[0].entity_id || '-'} "${f.topHits[0].textPreview}"`);
      } else {
        console.log(`     NO RESULTS`);
      }
    }
  }

  const fps = report.failures.filter((r) => r.issues.some((i) => i.includes('FALSE POSITIVE')));
  if (fps.length > 0) {
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`  FALSE POSITIVE DETAILS`);
    console.log(`${'─'.repeat(80)}`);
    for (const fp of fps) {
      console.log(`\n  Query: "${fp.query}"`);
      console.log(`  Resolved to: ${fp.entityId} (${fp.matchType}, confidence=${fp.confidence})`);
      if (fp.topHits.length > 0) {
        console.log(`  Top-1: entity=${fp.topHits[0].entity_id || '-'} "${fp.topHits[0].textPreview}"`);
      }
    }
  }

  const empties = report.failures.filter((r) => r.hitCount === 0 && !r.issues.some((i) => i.includes('expected no results')));
  if (empties.length > 0) {
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`  UNEXPECTED EMPTY RESULTS (${empties.length})`);
    console.log(`${'─'.repeat(80)}`);
    for (const e of empties) {
      console.log(`  "${e.query}" [${e.category}]`);
    }
  }

  console.log(`\n${'='.repeat(80)}\n`);
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
