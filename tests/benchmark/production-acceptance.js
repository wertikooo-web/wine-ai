'use strict';

/**
 * Production Hybrid Acceptance — 12 specific queries
 * 
 * Runs entity resolution + keyword search locally (no DB required).
 * Hybrid mode with semantic embeddings is verified via production API status.
 * 
 * Usage: node tests/benchmark/production-acceptance.js
 */

const { resolveEntity, resolveEntities, buildAliasContext } = require('../../src/knowledge/entityResolver');
const { search } = require('../../src/knowledge/search');

const QUERIES = [
  { q: 'WineMD', expect: { entityId: 'wine-md', mode: 'entity' } },
  { q: 'WainMD', expect: { entityId: null, entity: false } },
  { q: 'Где находится WineMD?', expect: { entityId: 'wine-md', mode: 'entity', top1Contains: 'адрес' } },
  { q: 'Povestește-mi despre crama Purcari', expect: { entityId: 'purcari', mode: 'entity' } },
  { q: 'Tell me about Purcari winery', expect: { entityId: 'purcari', mode: 'entity' } },
  { q: 'Parlez-moi de Purcari', expect: { entityId: 'purcari', mode: 'entity' } },
  { q: 'Расскажи про винодельню Mars', expect: { entityId: null, entity: false } },
  { q: 'Что лучше: Cricova или Mileștii Mici?', expect: { multiEntity: ['cricova', 'mileshtii-mici'] } },
  { q: 'Wo befindet sich das Weingut Cricova?', expect: { entityId: 'cricova', mode: 'entity' } },
  { q: 'Gdzie znajduje się winnica Cricova?', expect: { entityId: 'cricova', mode: 'entity' } },
  { q: 'Фетяска Нягрэ', expect: { entity: false } },
  { q: 'С чем подавать красное вино?', expect: { entity: false } },
];

async function run() {
  console.log('\n=== Production Hybrid Acceptance ===\n');
  
  const results = [];
  let passed = 0;
  let failed = 0;

  for (const { q, expect } of QUERIES) {
    const entityResult = resolveEntity(q);
    const searchResult = await search(q, { limit: 3 });
    
    const issues = [];
    
    // Entity resolution
    if (expect.entity === false && entityResult.found) {
      issues.push(`entity should not resolve, got ${entityResult.entityId}`);
    }
    if (expect.entityId && entityResult.entityId !== expect.entityId) {
      issues.push(`entityId expected=${expect.entityId} got=${entityResult.entityId}`);
    }
    if (expect.multiEntity) {
      const ids = [];
      if (entityResult.found) ids.push(entityResult.entityId);
      if (entityResult.allMentions) entityResult.allMentions.forEach((m) => { if (!ids.includes(m.entityId)) ids.push(m.entityId); });
      for (const id of expect.multiEntity) {
        if (!ids.includes(id)) issues.push(`multi-entity missing ${id}`);
      }
    }
    
    // Top-1 content
    if (expect.top1Contains && searchResult.hits.length > 0) {
      const topText = searchResult.hits[0].chunk.text.toLowerCase();
      if (!topText.includes(expect.top1Contains.toLowerCase())) {
        issues.push(`top-1 missing "${expect.top1Contains}"`);
      }
    }
    
    // Must have results (unless explicitly expecting none)
    if (expect.entity !== false && searchResult.hits.length === 0) {
      issues.push('no results returned');
    }

    const status = issues.length === 0 ? 'PASS' : 'FAIL';
    if (status === 'PASS') passed++; else failed++;
    
    console.log(`[${status}] "${q}"`);
    console.log(`  entity: ${entityResult.found ? entityResult.entityId : 'none'} (${entityResult.matchType || '-'})`);
    console.log(`  mode: ${searchResult.mode}`);
    if (searchResult.hits.length > 0) {
      searchResult.hits.slice(0, 3).forEach((h, i) => {
        console.log(`  top-${i+1}: entity=${h.chunk.metadata.entity_id || '-'} score=${Math.round(h.score*100)/100} "${h.chunk.text.slice(0, 80)}..."`);
      });
    } else {
      console.log('  NO RESULTS');
    }
    if (issues.length > 0) {
      issues.forEach((i) => console.log(`  ISSUE: ${i}`));
    }
    console.log();
    
    results.push({ query: q, status, entity: entityResult.entityId || 'none', mode: searchResult.mode, hitCount: searchResult.hits.length, issues });
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Passed: ${passed}/${QUERIES.length}`);
  console.log(`Failed: ${failed}/${QUERIES.length}`);
  
  if (failed > 0) {
    console.log('\nFailed queries:');
    results.filter((r) => r.status === 'FAIL').forEach((r) => {
      console.log(`  "${r.query}" — ${r.issues.join('; ')}`);
    });
  }
}

run().catch((err) => {
  console.error('Acceptance test failed:', err);
  process.exit(1);
});
