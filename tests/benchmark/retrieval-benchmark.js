'use strict';

/**
 * Phase 3 — Retrieval Relevance Benchmark (Hardened)
 *
 * Validates with strict criteria:
 * - Entity: expected entity in top-1 or top-3, no foreign contamination, relevant content
 * - Unknown: searchWinery found:false, no other winery returned, no evidence
 * - Multi-entity: both detected, evidence per entity, no displacement
 * - Suggestions: medium-confidence fuzzy returns suggestions
 *
 * Usage:
 *   node tests/benchmark/retrieval-benchmark.js [--json] [--hybrid]
 *
 * --hybrid: enable hybrid mode (requires DATABASE_URL + embeddings)
 */

const path = require('path');
const { search } = require('../../src/knowledge/search');
const { resolveEntity, resolveEntities } = require('../../src/knowledge/entityResolver');
const { loadIndex } = require('../../src/knowledge/index');

const JSON_OUTPUT = process.argv.includes('--json');
const HYBRID_MODE = process.argv.includes('--hybrid');

// Fixture index: production-like dataset with proper entity_id tags
const FIXTURE_INDEX = path.join(__dirname, 'benchmark-fixture-index.json');

// ─── Benchmark Queries ───────────────────────────────────────────────
// Each query has:
//   q: query text
//   cat: category
//   expect: validation expectations
//     entity: true/false — entity should resolve
//     entityId: expected entity ID (must be in top-1 or top-3 of results)
//     mode: expected search mode
//     top1Contains: text that MUST appear in top-1 chunk
//     top3Contains: text that MUST appear in at least one top-3 chunk
//     noResult: true if search should return 0 hits
//     multiEntity: array of entity IDs that should ALL be resolved
//     multiEntityEvidence: true if each entity needs >= 2 evidence chunks
//     relevantTopics: keywords that should appear in results
//     suggestEntityId: expected suggested entity for safe fuzzy match
//     expectSuggestion: true if suggestions should be returned

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

  // ═══ Category 5: Safe Fuzzy Suggestions ═══
  { q: 'WneMD', cat: 'safe-suggestion', expect: { entity: false, expectSuggestion: true, suggestEntityId: 'wine-md' } },
  { q: 'Purkari', cat: 'safe-suggestion', expect: { entity: false, expectSuggestion: true, suggestEntityId: 'purcari' } },
  { q: 'Crikova', cat: 'safe-suggestion', expect: { entity: false, expectSuggestion: true, suggestEntityId: 'cricova' } },

  // ═══ Category 6: Unknown Entity → fail-closed ═══
  { q: 'Domaine du Marquis', cat: 'unknown-entity', expect: { entity: false } },
  { q: 'Château Margaux', cat: 'unknown-entity', expect: { entity: false } },
  { q: 'Винодельня Новый Свет', cat: 'unknown-entity', expect: { entity: false } },
  { q: 'Barolo.it', cat: 'unknown-entity', expect: { entity: false } },
  { q: 'Mars', cat: 'unknown-entity', expect: { entity: false } },

  // ═══ Category 7: Multi-Entity ═══
  { q: 'Purcari и Cricova', cat: 'multi-entity', expect: { multiEntity: ['purcari', 'cricova'], multiEntityEvidence: true } },
  { q: 'Сравни Purcari и Mileștii Mici', cat: 'multi-entity', expect: { multiEntity: ['purcari', 'mileshtii-mici'], multiEntityEvidence: true } },

  // ═══ Category 8: General Wine Knowledge (RU) ═══
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

  // ═══ Category 9: General Wine Knowledge (EN) ═══
  { q: 'What is wine fermentation?', cat: 'general-en', expect: { entity: false, relevantTopics: ['fermentation'] } },
  { q: 'How to taste wine properly?', cat: 'general-en', expect: { entity: false } },
  { q: 'What are tannins in wine?', cat: 'general-en', expect: { entity: false, relevantTopics: ['tannins'] } },
  { q: 'Red vs white wine differences', cat: 'general-en', expect: { entity: false } },
  { q: 'Wine regions of Moldova', cat: 'general-en', expect: { entity: false, relevantTopics: ['Moldova', 'region'] } },
  { q: 'Best Moldovan wines', cat: 'general-en', expect: { entity: false, relevantTopics: ['Moldova'] } },
  { q: 'What is orange wine?', cat: 'general-en', expect: { entity: false } },
  { q: 'How to store wine at home?', cat: 'general-en', expect: { entity: false } },

  // ═══ Category 10: General Wine Knowledge (RO) ═══
  { q: 'Ce este fermentarea vinului?', cat: 'general-ro', expect: { entity: false } },
  { q: 'Cum se degustă vinul corect?', cat: 'general-ro', expect: { entity: false } },
  { q: 'Ce sunt taninii în vin?', cat: 'general-ro', expect: { entity: false } },
  { q: 'Regiunile viticole din Moldova', cat: 'general-ro', expect: { entity: false } },
  { q: 'Cele mai bune vinuri moldovenești', cat: 'general-ro', expect: { entity: false } },

  // ═══ Category 11: Grape Varieties ═══
  { q: 'Фетяска Нягрэ', cat: 'grape', expect: { entity: false, relevantTopics: ['Fetească', 'Neagră'] } },
  { q: 'Fetească Neagră', cat: 'grape', expect: { entity: false, relevantTopics: ['Fetească'] } },
  { q: 'Каберне Совиньон', cat: 'grape', expect: { entity: false, relevantTopics: ['Каберне', 'Совиньон'] } },
  { q: 'Рислинг', cat: 'grape', expect: { entity: false } },
  { q: 'Сира шираз', cat: 'grape', expect: { entity: false } },
  { q: 'Шардоне', cat: 'grape', expect: { entity: false } },

  // ═══ Category 12: Regions ═══
  { q: 'Винодельческий регион Кодру', cat: 'region', expect: { entity: false, relevantTopics: ['Кодру'] } },
  { q: 'Штефан Водэ вино', cat: 'region', expect: { entity: false } },
  { q: 'Purcari регион', cat: 'region', expect: { entity: true, entityId: 'purcari', relevantTopics: ['Purcari'] } },
  { q: 'Valul lui Traian', cat: 'region', expect: { entity: false } },

  // ═══ Category 13: Food Pairing ═══
  { q: 'С чем подавать красное вино?', cat: 'pairing', expect: { entity: false } },
  { q: 'Wine and cheese pairing', cat: 'pairing', expect: { entity: false } },
  { q: 'Вино к мясу', cat: 'pairing', expect: { entity: false } },
  { q: 'What wine goes with fish?', cat: 'pairing', expect: { entity: false } },

  // ═══ Category 14: Recommendations ═══
  { q: 'Посоветуй вино для подарка', cat: 'recommendation', expect: { entity: false } },
  { q: 'Recommend a dry red wine', cat: 'recommendation', expect: { entity: false } },
  { q: 'Какое вино выбрать для ужина?', cat: 'recommendation', expect: { entity: false } },
  { q: 'Best budget Moldovan wine', cat: 'recommendation', expect: { entity: false } },

  // ═══ Category 15: Wine Production ═══
  { q: 'Как делают вино?', cat: 'production', expect: { entity: false } },
  { q: 'Виноделие в Молдове', cat: 'production', expect: { entity: false, relevantTopics: ['Молдова'] } },
  { q: 'Organic wine production', cat: 'production', expect: { entity: false } },

  // ═══ Category 16: Events ═══
  { q: 'Decanter World Wine Awards 2026', cat: 'events', expect: { entity: false } },
  { q: 'ProWein 2024', cat: 'events', expect: { entity: false } },
  { q: 'Mundus Vini', cat: 'events', expect: { entity: false } },

  // ═══ Category 17: Wine Tourism ═══
  { q: 'Винный туризм в Молдове', cat: 'tourism', expect: { entity: false, relevantTopics: ['Молдова', 'туризм'] } },
  { q: 'Wine route Chisinau', cat: 'tourism', expect: { entity: false } },
  { q: 'Дегустационный зал Кишинёв', cat: 'tourism', expect: { entity: false } },

  // ═══ Category 18: Cross-Language (FR) ═══
  { q: 'Où se trouve le domaine viticole Cricova?', cat: 'cross-fr', expect: { entity: true, entityId: 'cricova' } },
  { q: 'Quelles sont les variétés de raisin utilisées en Moldavie?', cat: 'cross-fr', expect: { entity: false } },
  { q: 'Quel vin recommandez-vous pour un dîner?', cat: 'cross-fr', expect: { entity: false } },
  { q: 'Vin moldave Fetească Neagră', cat: 'cross-fr', expect: { entity: false } },

  // ═══ Category 19: Cross-Language (DE) ═══
  { q: 'Wo befindet sich das Weingut Cricova?', cat: 'cross-de', expect: { entity: true, entityId: 'cricova' } },
  { q: 'Welche Traubensorten wachsen in Moldawien?', cat: 'cross-de', expect: { entity: false } },
  { q: 'Welchen Wein empfehlen Sie zum Abendessen?', cat: 'cross-de', expect: { entity: false } },
  { q: 'Moldawischer Wein Fetească Neagră', cat: 'cross-de', expect: { entity: false } },

  // ═══ Category 20: Cross-Language (IT) ═══
  { q: 'Si trova la cantina Cricova?', cat: 'cross-it', expect: { entity: true, entityId: 'cricova' } },
  { q: 'Quali varietà di uva crescono in Moldavia?', cat: 'cross-it', expect: { entity: false } },
  { q: 'Vino moldavo Fetească Neagră', cat: 'cross-it', expect: { entity: false } },

  // ═══ Category 21: Cross-Language (ES) ═══
  { q: 'Dónde se encuentra la bodega Cricova?', cat: 'cross-es', expect: { entity: true, entityId: 'cricova' } },
  { q: '¿Qué variedades de uva crecen en Moldavia?', cat: 'cross-es', expect: { entity: false } },
  { q: 'Vino moldavo Fetească Neagră', cat: 'cross-es', expect: { entity: false } },

  // ═══ Category 22: Cross-Language (UK) ═══
  { q: 'Де знаходиться виноградня Cricova?', cat: 'cross-uk', expect: { entity: true, entityId: 'cricova' } },
  { q: 'Які сорти винограду ростуть у Молдові?', cat: 'cross-uk', expect: { entity: false } },
  { q: 'Молдавське вино Fetească Neagră', cat: 'cross-uk', expect: { entity: false } },

  // ═══ Category 23: Cross-Language (PL) ═══
  { q: 'Gdzie znajduje się winnica Cricova?', cat: 'cross-pl', expect: { entity: true, entityId: 'cricova' } },
  { q: 'Jakie odmiany winogron rosną w Mołdawii?', cat: 'cross-pl', expect: { entity: false } },
  { q: 'Mołdawskie wino Fetească Neagră', cat: 'cross-pl', expect: { entity: false } },

  // ═══ Category 24: Cross-Language Entity ═══
  { q: 'Où se trouve WineMD?', cat: 'cross-entity', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Wo ist WineMD?', cat: 'cross-entity', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Dove si trova WineMD?', cat: 'cross-entity', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Де знаходиться WineMD?', cat: 'cross-entity', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Gdzie jest WineMD?', cat: 'cross-entity', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },

  // ═══ Category 25: Mixed-Language ═══
  { q: 'Où est le siège de Wine & D?', cat: 'cross-mixed', expect: { entity: true, entityId: 'wine-md', mode: 'entity' } },
  { q: 'Cricova виноградня адрес', cat: 'cross-mixed', expect: { entity: true, entityId: 'cricova' } },

  // ═══ Category 26: Ambiguous / Edge ═══
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

function getResolvedEntityIds(entityResult) {
  const ids = [];
  if (entityResult.found) ids.push(entityResult.entityId);
  if (entityResult.allMentions) {
    for (const m of entityResult.allMentions) {
      if (!ids.includes(m.entityId)) ids.push(m.entityId);
    }
  }
  return ids;
}

function validateResult(query, searchResult, entityResult, expect) {
  const issues = [];

  // Entity resolution
  if (expect.entity !== undefined && entityResult.found !== expect.entity) {
    issues.push(`entity expected=${expect.entity} got=${entityResult.found}`);
  }
  if (expect.entityId && entityResult.entityId !== expect.entityId) {
    issues.push(`entityId expected=${expect.entityId} got=${entityResult.entityId}`);
  }

  // Mode
  if (expect.mode && searchResult.mode !== expect.mode) {
    issues.push(`mode expected=${expect.mode} got=${searchResult.mode}`);
  }

  // No result expectation
  if (expect.noResult && searchResult.hits.length > 0) {
    issues.push(`expected no results but got ${searchResult.hits.length}`);
  }

  // ─── Entity query: expected entity in top-1 or top-3 ───
  if (expect.entityId && searchResult.hits.length > 0) {
    const top3EntityIds = searchResult.hits.slice(0, 3)
      .map((h) => h.chunk.metadata.entity_id)
      .filter(Boolean);
    if (!top3EntityIds.includes(expect.entityId)) {
      issues.push(`entity ${expect.entityId} not in top-3 (got: ${top3EntityIds.join(', ') || 'none'})`);
    }
  }

  // ─── Contamination check: no foreign entity in top-1 for entity queries ───
  if (expect.entityId && searchResult.hits.length > 0) {
    const top1Entity = searchResult.hits[0].chunk.metadata.entity_id;
    if (top1Entity && top1Entity !== expect.entityId) {
      issues.push(`CONTAMINATION: top-1 entity is ${top1Entity}, expected ${expect.entityId}`);
    }
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

  // ─── Multi-entity: both detected + evidence per entity ───
  if (expect.multiEntity) {
    const resolvedIds = getResolvedEntityIds(entityResult);
    for (const expectedId of expect.multiEntity) {
      if (!resolvedIds.includes(expectedId)) {
        issues.push(`multi-entity missing ${expectedId}`);
      }
    }
    // Check evidence balance: each entity should have chunks in results
    if (expect.multiEntityEvidence && searchResult.hits.length > 0) {
      for (const expectedId of expect.multiEntity) {
        const entityChunks = searchResult.hits.filter(
          (h) => h.chunk.metadata.entity_id === expectedId
        );
        if (entityChunks.length < 1) {
          issues.push(`multi-entity insufficient evidence for ${expectedId} (0 chunks in results)`);
        }
      }
    }
  }

  // ─── Safe suggestion check ───
  if (expect.expectSuggestion) {
    if (!entityResult.suggestions || entityResult.suggestions.length === 0) {
      issues.push('expected suggestions but none returned');
    } else if (expect.suggestEntityId) {
      const suggested = entityResult.suggestions.map((s) => s.entityId);
      if (!suggested.includes(expect.suggestEntityId)) {
        issues.push(`expected suggestion for ${expect.suggestEntityId}, got: ${suggested.join(', ')}`);
      }
    }
  }

  // Relevant topics
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
  const index = loadIndex(FIXTURE_INDEX);
  const modeLabel = HYBRID_MODE ? 'Hybrid (semantic+keyword)' : 'Keyword only';
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  Phase 3 — Retrieval Relevance Benchmark (Hardened)`);
  console.log(`${'='.repeat(80)}`);
  console.log(`  Mode:    ${modeLabel}`);
  console.log(`  Index:   ${index.chunks.length} chunks, ${index.chunks.filter((c) => c.metadata.entity_id).length} entity-tagged`);
  console.log(`  Fixture: ${FIXTURE_INDEX}`);
  console.log(`  Queries: ${QUERIES.length}`);
  console.log(`${'='.repeat(80)}\n`);

  const results = [];
  const categoryStats = {};
  const latencies = [];
  let assertionPassCount = 0;
  let assertionFailCount = 0;
  let entityResolutionCorrect = 0;
  let entityResolutionTotal = 0;
  let top1EntityCorrect = 0;
  let top3EntityRecall = 0;
  let entityWithHitsQueries = 0;
  let contaminationCount = 0;
  let unknownRejections = 0;
  let unknownQueries = 0;
  let multiEntityCorrect = 0;
  let multiEntityCompleteEvidence = 0;
  let multiEntityQueries = 0;
  let suggestionCorrect = 0;
  let suggestionQueries = 0;
  const langStats = {};

  for (let i = 0; i < QUERIES.length; i++) {
    const { q, cat, expect } = QUERIES[i];
    const startTime = Date.now();

    const entityResult = resolveEntity(q, { includeSuggestions: true });
    const searchResult = await search(q, { limit: 5, diagnostics: true, indexFile: FIXTURE_INDEX });
    const searchMs = Date.now() - startTime;
    latencies.push(searchMs);

    const issues = validateResult(q, searchResult, entityResult, expect);

    // ─── Track assertion pass/fail ───
    if (issues.length === 0) assertionPassCount++;
    else assertionFailCount++;

    // ─── Entity resolution accuracy ───
    if (expect.entityId) {
      entityResolutionTotal++;
      const resolvedIds = getResolvedEntityIds(entityResult);
      if (resolvedIds.includes(expect.entityId)) entityResolutionCorrect++;
    }

    // ─── Top-1 entity accuracy ───
    if (expect.entityId && searchResult.hits.length > 0) {
      entityWithHitsQueries++;
      const top1Entity = searchResult.hits[0].chunk.metadata.entity_id;
      if (top1Entity === expect.entityId) top1EntityCorrect++;
    }

    // ─── Top-3 entity recall ───
    if (expect.entityId && searchResult.hits.length > 0) {
      const top3Entities = searchResult.hits.slice(0, 3)
        .map((h) => h.chunk.metadata.entity_id)
        .filter(Boolean);
      if (top3Entities.includes(expect.entityId)) top3EntityRecall++;
    }

    // ─── Contamination ───
    if (expect.entityId && searchResult.hits.length > 0) {
      const top1Entity = searchResult.hits[0].chunk.metadata.entity_id;
      if (top1Entity && top1Entity !== expect.entityId) contaminationCount++;
    }

    // ─── Unknown entity rejection ───
    if (expect.entity === false) {
      unknownQueries++;
      if (!entityResult.found) unknownRejections++;
    }

    // ─── Multi-entity completeness ───
    if (expect.multiEntity) {
      multiEntityQueries++;
      const resolvedIds = getResolvedEntityIds(entityResult);
      const allFound = expect.multiEntity.every((id) => resolvedIds.includes(id));
      if (allFound) multiEntityCorrect++;
      // Check evidence balance
      if (expect.multiEntityEvidence && searchResult.hits.length > 0) {
        let allSufficient = true;
        for (const expectedId of expect.multiEntity) {
          const entityChunks = searchResult.hits.filter(
            (h) => h.chunk.metadata.entity_id === expectedId
          );
          if (entityChunks.length < 1) allSufficient = false;
        }
        if (allSufficient) multiEntityCompleteEvidence++;
      }
    }

    // ─── Suggestion accuracy ───
    if (expect.expectSuggestion) {
      suggestionQueries++;
      if (entityResult.suggestions && entityResult.suggestions.length > 0) {
        if (expect.suggestEntityId) {
          const suggested = entityResult.suggestions.map((s) => s.entityId);
          if (suggested.includes(expect.suggestEntityId)) suggestionCorrect++;
        } else {
          suggestionCorrect++;
        }
      }
    }

    // ─── Per-language accuracy ───
    const langMatch = cat.match(/^(entity-nl|cross-(fr|de|it|es|uk|pl)|general-(ru|en|ro))/);
    if (langMatch) {
      const lang = langMatch[2] || langMatch[1].replace('general-', '');
      if (!langStats[lang]) langStats[lang] = { total: 0, passed: 0 };
      langStats[lang].total++;
      if (issues.length === 0) langStats[lang].passed++;
    }

    const diag = {
      query: q,
      category: cat,
      entityResolved: entityResult.found,
      entityId: entityResult.entityId,
      matchType: entityResult.matchType,
      confidence: entityResult.confidence,
      suggestions: entityResult.suggestions || null,
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
      hitDiagnostics: searchResult.hitDiagnostics || null,
      issues,
      passed: issues.length === 0,
    };

    results.push(diag);

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

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];
  const avgLatency = Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length);

  const report = {
    mode: HYBRID_MODE ? 'hybrid' : 'keyword',
    summary: {
      totalQueries: results.length,
      assertionsPassed: assertionPassCount,
      assertionsFailed: assertionFailCount,
      assertionPassRate: Math.round(assertionPassCount / results.length * 100) + '%',
      entityResolutionAccuracy: entityResolutionTotal > 0
        ? Math.round(entityResolutionCorrect / entityResolutionTotal * 100) + '%' : 'N/A',
      top1EntityAccuracy: entityWithHitsQueries > 0
        ? Math.round(top1EntityCorrect / entityWithHitsQueries * 100) + '%' : 'N/A',
      top3EntityRecall: entityWithHitsQueries > 0
        ? Math.round(top3EntityRecall / entityWithHitsQueries * 100) + '%' : 'N/A',
      contaminationRate: entityWithHitsQueries > 0
        ? Math.round(contaminationCount / entityWithHitsQueries * 100) + '%' : '0%',
      unknownRejectionRate: unknownQueries > 0
        ? Math.round(unknownRejections / unknownQueries * 100) + '%' : 'N/A',
      multiEntityCompleteness: multiEntityQueries > 0
        ? Math.round(multiEntityCorrect / multiEntityQueries * 100) + '%' : 'N/A',
      multiEntityEvidenceBalance: multiEntityQueries > 0
        ? Math.round(multiEntityCompleteEvidence / multiEntityQueries * 100) + '%' : 'N/A',
      suggestionAccuracy: suggestionQueries > 0
        ? Math.round(suggestionCorrect / suggestionQueries * 100) + '%' : 'N/A',
      latency: { avgMs: avgLatency, p50Ms: p50, p95Ms: p95, p99Ms: p99 },
    },
    perLanguage: langStats,
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
  const { summary, categoryStats, perLanguage, failures } = report;

  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  SUMMARY (${report.mode} mode)`);
  console.log(`${'─'.repeat(80)}`);
  console.log(`  Total queries:              ${summary.assertionsPassed + summary.assertionsFailed}`);
  console.log(`  Assertions passed:          ${summary.assertionsPassed}`);
  console.log(`  Assertions failed:          ${summary.assertionsFailed}`);
  console.log(`  Assertion pass rate:        ${summary.assertionPassRate}`);
  console.log(`  Entity resolution accuracy: ${summary.entityResolutionAccuracy}`);
  console.log(`  Top-1 entity accuracy:      ${summary.top1EntityAccuracy}`);
  console.log(`  Top-3 entity recall:        ${summary.top3EntityRecall}`);
  console.log(`  Contamination rate:         ${summary.contaminationRate}`);
  console.log(`  Unknown rejection rate:     ${summary.unknownRejectionRate}`);
  console.log(`  Multi-entity completeness:  ${summary.multiEntityCompleteness}`);
  console.log(`  Multi-entity evidence:      ${summary.multiEntityEvidenceBalance}`);
  console.log(`  Suggestion accuracy:        ${summary.suggestionAccuracy}`);
  console.log(`  Latency avg:                ${summary.latency.avgMs}ms`);
  console.log(`  Latency p50:                ${summary.latency.p50Ms}ms`);
  console.log(`  Latency p95:                ${summary.latency.p95Ms}ms`);
  console.log(`  Latency p99:                ${summary.latency.p99Ms}ms`);

  if (perLanguage && Object.keys(perLanguage).length > 0) {
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`  PER-LANGUAGE ACCURACY`);
    console.log(`${'─'.repeat(80)}`);
    for (const [lang, stats] of Object.entries(perLanguage)) {
      const passRate = Math.round(stats.passed / stats.total * 100);
      console.log(`  ${lang.padEnd(8)} ${String(stats.passed).padStart(3)}/${String(stats.total).padStart(3)} passed (${passRate}%)`);
    }
  }

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

  console.log(`\n${'='.repeat(80)}\n`);
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
