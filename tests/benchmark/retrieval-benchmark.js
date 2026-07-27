'use strict';

/**
 * Phase 2 — Semantic Retrieval Validation Benchmark
 * 
 * Runs 100+ queries across categories, captures full diagnostics,
 * measures timing, checks for false positives/negatives.
 * 
 * Usage: node tests/benchmark/retrieval-benchmark.js [--no-alias] [--json]
 */

const path = require('path');
const { search } = require('../../src/knowledge/search');
const { resolveEntity } = require('../../src/knowledge/entityResolver');
const { loadIndex } = require('../../src/knowledge/index');

const NO_ALIAS = process.argv.includes('--no-alias');
const JSON_OUTPUT = process.argv.includes('--json');

// ─── Benchmark Queries ───────────────────────────────────────────────
// Each query has: q (query text), cat (category), expect (expected behavior)
// expect.entity: true if entity should resolve, false if not
// expect.entityId: expected entity ID if entity should resolve
// expect.mode: expected search mode ('entity', 'keyword', 'hybrid')
// expect.topChunkContains: text that should appear in top-1 chunk (case-insensitive)
// expect.falsePositive: true if this should NOT match wine-md
// expect.relevantTopics: keywords that should appear in results

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

  // ═══ Category 2: WineMD Entity (natural language with entity mention) ═══
  { q: 'Расскажи про WineMD', cat: 'entity-nl', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Что такое Wine & D?', cat: 'entity-nl', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Где находится WineMD?', cat: 'entity-nl', expect: { entity: true, entityId: 'wine-md', mode: 'entity', topChunkContains: 'адрес' } },
  { q: 'Что есть у WineMD?', cat: 'entity-nl', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Расскажи о Wine & D', cat: 'entity-nl', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Tell me about WineMD', cat: 'entity-nl', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Where is WineMD located?', cat: 'entity-nl', expect: { entity: true, entityId: 'wine-md', mode: 'entity', topChunkContains: 'address' } },
  { q: 'What does WineMD offer?', cat: 'entity-nl', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Ce este Wine.md?', cat: 'entity-nl', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Unde se află WineMD?', cat: 'entity-nl', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },

  // ═══ Category 3: WineMD Entity (typos / fuzzy) ═══
  { q: 'Wine Md', cat: 'entity-fuzzy', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'winemd', cat: 'entity-fuzzy', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'wine md', cat: 'entity-fuzzy', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'WainMD', cat: 'entity-fuzzy', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'вине эм ди', cat: 'entity-fuzzy', expect: { entity: false } },
  { q: 'wine and d', cat: 'entity-fuzzy', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },

  // ═══ Category 4: False Positives (should NOT resolve to wine-md) ═══
  { q: 'Purcari', cat: 'false-positive', expect: { entity: false, falsePositive: true } },
  { q: 'Cricova', cat: 'false-positive', expect: { entity: false, falsePositive: true } },
  { q: 'Asconi', cat: 'false-positive', expect: { entity: false, falsePositive: true } },
  { q: 'Gitana', cat: 'false-positive', expect: { entity: false, falsePositive: true } },
  { q: 'Wine House', cat: 'false-positive', expect: { entity: false, falsePositive: true } },
  { q: 'Wine Museum', cat: 'false-positive', expect: { entity: false, falsePositive: true } },
  { q: 'Mileștii Mici', cat: 'false-positive', expect: { entity: false, falsePositive: true } },
  { q: 'Kvint', cat: 'false-positive', expect: { entity: false, falsePositive: true } },
  { q: 'Fautor', cat: 'false-positive', expect: { entity: false, falsePositive: true } },
  { q: 'Castel Mimi', cat: 'false-positive', expect: { entity: false, falsePositive: true } },
  { q: 'Vinuri de Comrat', cat: 'false-positive', expect: { entity: false, falsePositive: true } },
  { q: 'Novak', cat: 'false-positive', expect: { entity: false, falsePositive: true } },

  // ═══ Category 5: General Wine Knowledge (RU) ═══
  { q: 'Что такое ферментация вина?', cat: 'general-ru', expect: { entity: false, relevantTopics: ['ферментация', 'виноделие'] } },
  { q: 'Какие сорта винограда растут в Молдове?', cat: 'general-ru', expect: { entity: false, relevantTopics: ['сорта', 'виноград', 'Молдова'] } },
  { q: 'Чем отличается красное вино от белого?', cat: 'general-ru', expect: { entity: false, relevantTopics: ['красное', 'белое'] } },
  { q: 'Как правильно дегустировать вино?', cat: 'general-ru', expect: { entity: false, relevantTopics: ['дегустация'] } },
  { q: 'Что такое танины в вине?', cat: 'general-ru', expect: { entity: false, relevantTopics: ['танины'] } },
  { q: 'Как хранить вино дома?', cat: 'general-ru', expect: { entity: false } },
  { q: 'Что такое купажирование вина?', cat: 'general-ru', expect: { entity: false } },
  { q: 'Как читать этикетку вина?', cat: 'general-ru', expect: { entity: false } },
  { q: 'Что такое апелласьон в виноделии?', cat: 'general-ru', expect: { entity: false } },
  { q: 'Как производят шампанское?', cat: 'general-ru', expect: { entity: false } },

  // ═══ Category 6: General Wine Knowledge (EN) ═══
  { q: 'What is wine fermentation?', cat: 'general-en', expect: { entity: false, relevantTopics: ['fermentation'] } },
  { q: 'How to taste wine properly?', cat: 'general-en', expect: { entity: false, relevantTopics: ['tasting'] } },
  { q: 'What are tannins in wine?', cat: 'general-en', expect: { entity: false, relevantTopics: ['tannins'] } },
  { q: 'Red vs white wine differences', cat: 'general-en', expect: { entity: false } },
  { q: 'Wine regions of Moldova', cat: 'general-en', expect: { entity: false, relevantTopics: ['Moldova', 'region'] } },
  { q: 'Best Moldovan wines', cat: 'general-en', expect: { entity: false, relevantTopics: ['Moldova'] } },
  { q: 'What is orange wine?', cat: 'general-en', expect: { entity: false } },
  { q: 'How to store wine at home?', cat: 'general-en', expect: { entity: false } },

  // ═══ Category 7: General Wine Knowledge (RO) ═══
  { q: 'Ce este fermentarea vinului?', cat: 'general-ro', expect: { entity: false } },
  { q: 'Cum se degustă vinul corect?', cat: 'general-ro', expect: { entity: false } },
  { q: 'Ce sunt taninii în vin?', cat: 'general-ro', expect: { entity: false } },
  { q: 'Regiunile viticole din Moldova', cat: 'general-ro', expect: { entity: false, relevantTopics: ['Moldova', 'regiune'] } },
  { q: 'Cele mai bune vinuri moldovenești', cat: 'general-ro', expect: { entity: false } },

  // ═══ Category 8: Specific Wineries ═══
  { q: 'Расскажи про Cricova', cat: 'winery', expect: { entity: false, relevantTopics: ['Cricova'] } },
  { q: 'Вина Cricova', cat: 'winery', expect: { entity: false, relevantTopics: ['Cricova'] } },
  { q: 'Purcari вина', cat: 'winery', expect: { entity: false, relevantTopics: ['Purcari'] } },
  { q: 'Mileștii Mici винный погреб', cat: 'winery', expect: { entity: false, relevantTopics: ['Mileștii'] } },
  { q: 'Crama Dealul de Aur', cat: 'winery', expect: { entity: false, relevantTopics: ['Dealul'] } },
  { q: 'Kvint коньяк', cat: 'winery', expect: { entity: false, relevantTopics: ['Kvint'] } },

  // ═══ Category 9: Grape Varieties ═══
  { q: 'Фетяска Нягрэ', cat: 'grape', expect: { entity: false, relevantTopics: ['Fetească', 'Neagră'] } },
  { q: 'Fetească Neagră', cat: 'grape', expect: { entity: false, relevantTopics: ['Fetească'] } },
  { q: 'Каберне Совиньон', cat: 'grape', expect: { entity: false, relevantTopics: ['Каберне', 'Совиньон'] } },
  { q: 'Рислинг', cat: 'grape', expect: { entity: false } },
  { q: 'Сира шираз', cat: 'grape', expect: { entity: false } },
  { q: 'Шардоне', cat: 'grape', expect: { entity: false } },

  // ═══ Category 10: Regions ═══
  { q: 'Винодельческий регион Кодру', cat: 'region', expect: { entity: false, relevantTopics: ['Кодру'] } },
  { q: 'Штефан Водэ вино', cat: 'region', expect: { entity: false, relevantTopics: ['Ștefan'] } },
  { q: 'Purcari регион', cat: 'region', expect: { entity: false, relevantTopics: ['Purcari'] } },
  { q: 'Valul lui Traian', cat: 'region', expect: { entity: false } },

  // ═══ Category 11: Food Pairing ═══
  { q: 'С чем подавать красное вино?', cat: 'pairing', expect: { entity: false } },
  { q: 'Wine and cheese pairing', cat: 'pairing', expect: { entity: false } },
  { q: 'Вино к мясу', cat: 'pairing', expect: { entity: false } },
  { q: 'What wine goes with fish?', cat: 'pairing', expect: { entity: false } },

  // ═══ Category 12: Recommendations ═══
  { q: 'Посоветуй вино для подарка', cat: 'recommendation', expect: { entity: false } },
  { q: 'Recommend a dry red wine', cat: 'recommendation', expect: { entity: false } },
  { q: 'Какое вино выбрать для ужина?', cat: 'recommendation', expect: { entity: false } },
  { q: 'Best budget Moldovan wine', cat: 'recommendation', expect: { entity: false } },

  // ═══ Category 13: Wine Process / Production ═══
  { q: 'Как делают вино?', cat: 'production', expect: { entity: false } },
  { q: 'Виноделие в Молдове', cat: 'production', expect: { entity: false, relevantTopics: ['Молдова'] } },
  { q: 'Organic wine production', cat: 'production', expect: { entity: false } },
  { q: 'Biodynamic vineyards Moldova', cat: 'production', expect: { entity: false } },

  // ═══ Category 14: Awards / Events ═══
  { q: 'Decanter World Wine Awards 2026', cat: 'events', expect: { entity: false } },
  { q: 'ProWein 2024', cat: 'events', expect: { entity: false } },
  { q: 'Mundus Vini', cat: 'events', expect: { entity: false } },

  // ═══ Category 15: Wine Tourism ═══
  { q: 'Винный туризм в Молдове', cat: 'tourism', expect: { entity: false, relevantTopics: ['Молдова', 'туризм'] } },
  { q: 'Wine route Chisinau', cat: 'tourism', expect: { entity: false } },
  { q: 'Дегустационный зал Кишинёв', cat: 'tourism', expect: { entity: false } },

  // ═══ Category 16: Multilingual Mixed ═══
  { q: 'Расскажи про молдавское вино на русском', cat: 'multilingual', expect: { entity: false } },
  { q: 'Tell me about Moldovan wine regions', cat: 'multilingual', expect: { entity: false } },
  { q: 'Spune-mi despre vinurile din Moldova', cat: 'multilingual', expect: { entity: false } },

  // ═══ Category 19: Cross-Language Retrieval (FR) ═══
  { q: 'Où se trouve le domaine viticole Cricova?', cat: 'cross-fr', expect: { entity: false } },
  { q: 'Quelles sont les variétés de raisin utilisées en Moldavie?', cat: 'cross-fr', expect: { entity: false } },
  { q: 'Quel vin recommandez-vous pour un dîner?', cat: 'cross-fr', expect: { entity: false } },
  { q: 'Comment déguster correctement le vin?', cat: 'cross-fr', expect: { entity: false } },
  { q: 'Vin moldave Fetească Neagră', cat: 'cross-fr', expect: { entity: false } },

  // ═══ Category 20: Cross-Language Retrieval (DE) ═══
  { q: 'Wo befindet sich das Weingut Cricova?', cat: 'cross-de', expect: { entity: false } },
  { q: 'Welche Traubensorten wachsen in Moldawien?', cat: 'cross-de', expect: { entity: false } },
  { q: 'Welchen Wein empfehlen Sie zum Abendessen?', cat: 'cross-de', expect: { entity: false } },
  { q: 'Wie verkostet man Wein richtig?', cat: 'cross-de', expect: { entity: false } },
  { q: 'Moldawischer Wein Fetească Neagră', cat: 'cross-de', expect: { entity: false } },

  // ═══ Category 21: Cross-Language Retrieval (IT) ═══
  { q: 'Si trova la cantina Cricova?', cat: 'cross-it', expect: { entity: false } },
  { q: 'Quali varietà di uva crescono in Moldavia?', cat: 'cross-it', expect: { entity: false } },
  { q: 'Che vino consigliate per la cena?', cat: 'cross-it', expect: { entity: false } },
  { q: 'Come si degusta correttamente il vino?', cat: 'cross-it', expect: { entity: false } },
  { q: 'Vino moldavo Fetească Neagră', cat: 'cross-it', expect: { entity: false } },

  // ═══ Category 22: Cross-Language Retrieval (ES) ═══
  { q: 'Dónde se encuentra la bodega Cricova?', cat: 'cross-es', expect: { entity: false } },
  { q: '¿Qué variedades de uva crecen en Moldavia?', cat: 'cross-es', expect: { entity: false } },
  { q: '¿Qué vino recomiendan para la cena?', cat: 'cross-es', expect: { entity: false } },
  { q: '¿Cómo se degusta correctamente el vino?', cat: 'cross-es', expect: { entity: false } },
  { q: 'Vino moldavo Fetească Neagră', cat: 'cross-es', expect: { entity: false } },

  // ═══ Category 23: Cross-Language Retrieval (UK) ═══
  { q: 'Де знаходиться виноградня Cricova?', cat: 'cross-uk', expect: { entity: false } },
  { q: 'Які сорти винограду ростуть у Молдові?', cat: 'cross-uk', expect: { entity: false } },
  { q: 'Яке вино порадите для вечері?', cat: 'cross-uk', expect: { entity: false } },
  { q: 'Як правильно дегустувати вино?', cat: 'cross-uk', expect: { entity: false } },
  { q: 'Молдавське вино Fetească Neagră', cat: 'cross-uk', expect: { entity: false } },

  // ═══ Category 24: Cross-Language Retrieval (PL) ═══
  { q: 'Gdzie znajduje się winnica Cricova?', cat: 'cross-pl', expect: { entity: false } },
  { q: 'Jakie odmiany winogron rosną w Mołdawii?', cat: 'cross-pl', expect: { entity: false } },
  { q: 'Jakie wino polecacie na kolację?', cat: 'cross-pl', expect: { entity: false } },
  { q: 'Jak prawidłowo degustować wino?', cat: 'cross-pl', expect: { entity: false } },
  { q: 'Mołdawskie wino Fetească Neagră', cat: 'cross-pl', expect: { entity: false } },

  // ═══ Category 25: Cross-Language Entity (WineMD in various languages) ═══
  { q: 'Où se trouve WineMD?', cat: 'cross-entity', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Wo ist WineMD?', cat: 'cross-entity', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Dove si trova WineMD?', cat: 'cross-entity', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Де знаходиться WineMD?', cat: 'cross-entity', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Gdzie jest WineMD?', cat: 'cross-entity', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },

  // ═══ Category 26: Mixed-Language Queries ═══
  { q: 'Wine MD地址在哪里', cat: 'cross-mixed', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Où est le siège de Wine & D?', cat: 'cross-mixed', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Cricova виноградня адрес', cat: 'cross-mixed', expect: { entity: false } },

  // ═══ Category 27: Brand Names (universal, no translation) ═══
  { q: 'Purcari wine', cat: 'cross-brand', expect: { entity: false } },
  { q: 'Cricova brut', cat: 'cross-brand', expect: { entity: false } },
  { q: 'Fetească Neagră wine', cat: 'cross-brand', expect: { entity: false } },
  { q: 'Mileștii Mici collection', cat: 'cross-brand', expect: { entity: false } },

  // ═══ Category 17: Conversational / Ambiguous ═══
  { q: 'Что это вообще такое?', cat: 'ambiguous', expect: { entity: false } },
  { q: 'расскажи про этот магазин', cat: 'ambiguous', expect: { entity: false } },
  { q: 'что у вас есть?', cat: 'ambiguous', expect: { entity: false } },
  { q: 'Расскажи мне что-нибудь интересное', cat: 'ambiguous', expect: { entity: false } },
  { q: 'Привет', cat: 'ambiguous', expect: { entity: false } },
  { q: 'Hello', cat: 'ambiguous', expect: { entity: false } },

  // ═══ Category 18: Negative / Edge Cases ═══
  { q: 'Автомобиль', cat: 'edge', expect: { entity: false } },
  { q: 'Погода сегодня', cat: 'edge', expect: { entity: false } },
  { q: 'Как сварить борщ?', cat: 'edge', expect: { entity: false } },
  { q: '', cat: 'edge', expect: { entity: false } },
  { q: 'a', cat: 'edge', expect: { entity: false } },
];

// ─── Benchmark Runner ────────────────────────────────────────────────

async function runBenchmark() {
  const index = loadIndex();
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  Phase 2 — Semantic Retrieval Validation Benchmark`);
  console.log(`${'='.repeat(80)}`);
  console.log(`  Index: ${index.chunks.length} chunks, ${index.chunks.filter(c => c.metadata.entity_id).length} entity-tagged`);
  console.log(`  Alias resolver: ${NO_ALIAS ? 'DISABLED' : 'ENABLED'}`);
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

    // Resolve entity (with or without alias)
    let entityResult;
    if (NO_ALIAS) {
      entityResult = { found: false, entityId: null, canonicalName: null, matchedAlias: null, matchType: null, confidence: 0 };
    } else {
      entityResult = resolveEntity(q);
    }

    // Run search
    const searchResult = await search(q, { limit: 5 });
    const searchMs = Date.now() - startTime;

    // Collect diagnostics
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
      topHits: searchResult.hits.map((h, idx) => ({
        rank: idx + 1,
        chunkId: h.chunk.id,
        title: h.chunk.metadata.title,
        score: Math.round(h.score * 100) / 100,
        source: h.chunk.metadata.source_file,
        winery: h.chunk.metadata.winery,
        region: h.chunk.metadata.region,
        grape: h.chunk.metadata.grape,
        language: h.chunk.metadata.language,
        textPreview: h.chunk.text.slice(0, 120),
      })),
    };

    // Validate expectations
    const issues = [];
    if (expect.entity !== undefined && entityResult.found !== expect.entity) {
      issues.push(`entity expected=${expect.entity} got=${entityResult.found}`);
    }
    if (expect.entityId && entityResult.entityId !== expect.entityId) {
      issues.push(`entityId expected=${expect.entityId} got=${entityResult.entityId}`);
    }
    if (expect.mode && searchResult.mode !== expect.mode) {
      issues.push(`mode expected=${expect.mode} got=${searchResult.mode}`);
    }
    if (expect.falsePositive && entityResult.found) {
      issues.push(`FALSE POSITIVE: resolved to ${entityResult.entityId}`);
      falsePositiveCount++;
    }
    if (expect.topChunkContains && searchResult.hits.length > 0) {
      const topText = searchResult.hits[0].chunk.text.toLowerCase();
      if (!topText.includes(expect.topChunkContains.toLowerCase())) {
        issues.push(`top chunk missing expected text: "${expect.topChunkContains}"`);
      }
    }
    if (searchResult.hits.length === 0) {
      emptyResultCount++;
    }
    if (entityResult.found) {
      entityMatchCount++;
    }

    diag.issues = issues;
    diag.passed = issues.length === 0;
    results.push(diag);
    totalSearchMs += searchMs;

    // Category stats
    if (!categoryStats[cat]) categoryStats[cat] = { total: 0, passed: 0, entityMatches: 0, avgMs: 0, totalMs: 0 };
    categoryStats[cat].total++;
    if (issues.length === 0) categoryStats[cat].passed++;
    if (entityResult.found) categoryStats[cat].entityMatches++;
    categoryStats[cat].totalMs += searchMs;

    // Progress
    if ((i + 1) % 10 === 0 || i === QUERIES.length - 1) {
      process.stderr.write(`  Progress: ${i + 1}/${QUERIES.length}\r`);
    }
  }

  // Calculate final stats
  for (const cat of Object.keys(categoryStats)) {
    categoryStats[cat].avgMs = Math.round(categoryStats[cat].totalMs / categoryStats[cat].total);
  }

  const passedCount = results.filter(r => r.passed).length;
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
      aliasResolver: NO_ALIAS ? 'disabled' : 'enabled',
    },
    categoryStats,
    results,
  };

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  return report;
}

function printReport(report) {
  const { summary, categoryStats, results } = report;

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
  console.log(`  Alias resolver:     ${summary.aliasResolver}`);

  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  CATEGORY BREAKDOWN`);
  console.log(`${'─'.repeat(80)}`);
  for (const [cat, stats] of Object.entries(categoryStats)) {
    const passRate = Math.round(stats.passed / stats.total * 100);
    console.log(`  ${cat.padEnd(20)} ${String(stats.passed).padStart(3)}/${String(stats.total).padStart(3)} passed (${passRate}%) | entity: ${stats.entityMatches} | avg: ${stats.avgMs}ms`);
  }

  // Show failures
  const failures = results.filter(r => !r.passed);
  if (failures.length > 0) {
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`  FAILURES (${failures.length})`);
    console.log(`${'─'.repeat(80)}`);
    for (const f of failures) {
      console.log(`\n  ❌ "${f.query}" [${f.category}]`);
      for (const issue of f.issues) {
        console.log(`     → ${issue}`);
      }
      if (f.topHits.length > 0) {
        console.log(`     top-1: score=${f.topHits[0].score} "${f.topHits[0].textPreview}"`);
      } else {
        console.log(`     NO RESULTS`);
      }
    }
  }

  // False positive details
  const fps = results.filter(r => r.issues.some(i => i.includes('FALSE POSITIVE')));
  if (fps.length > 0) {
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`  FALSE POSITIVE DETAILS`);
    console.log(`${'─'.repeat(80)}`);
    for (const fp of fps) {
      console.log(`\n  Query: "${fp.query}"`);
      console.log(`  Resolved to: ${fp.entityId} (${fp.matchType}, confidence=${fp.confidence})`);
      console.log(`  Mode: ${fp.mode}`);
      if (fp.topHits.length > 0) {
        console.log(`  Top-1: "${fp.topHits[0].textPreview}"`);
      }
    }
  }

  // Empty results
  const empties = results.filter(r => r.hitCount === 0);
  if (empties.length > 0) {
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`  EMPTY RESULTS (${empties.length})`);
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
