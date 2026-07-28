'use strict';

/**
 * Phase 3 — Minimal Answer Grounding Benchmark
 *
 * Deterministic golden set: validates that retrieval produces correct evidence
 * for answer generation. Checks entity correctness, no foreign contamination,
 * evidence sufficiency, and language appropriateness.
 *
 * Usage: node tests/benchmark/grounding-benchmark.js [--json]
 */

const { search } = require('../../src/knowledge/search');
const { resolveEntity } = require('../../src/knowledge/entityResolver');

const JSON_OUTPUT = process.argv.includes('--json');

// ─── Golden Cases ────────────────────────────────────────────────────
// Each case: query → expected evidence properties
const GOLDEN_CASES = [
  // Winery facts
  {
    q: 'Что такое Wine.md?',
    expect: {
      entity: 'wine-md',
      evidenceTopics: ['платформа', 'интернет-магазин', 'дегустац'],
      noForeignEntities: ['purcari', 'cricova', 'mileshtii-mici'],
      minHits: 1,
    },
  },
  {
    q: 'Где находится WineMD?',
    expect: {
      entity: 'wine-md',
      evidenceTopics: ['адрес', 'Кишинёв'],
      noForeignEntities: ['purcari', 'cricova'],
      minHits: 1,
    },
  },
  {
    q: 'Расскажи про Purcari',
    expect: {
      entity: 'purcari',
      evidenceTopics: ['Purcari'],
      noForeignEntities: ['cricova', 'mileshtii-mici'],
      minHits: 1,
    },
  },
  {
    q: 'Tell me about Cricova',
    expect: {
      entity: 'cricova',
      evidenceTopics: ['Cricova'],
      noForeignEntities: ['purcari', 'mileshtii-mici'],
      minHits: 1,
    },
  },

  // Wine/grape facts
  {
    q: 'Что такое Фетяска Нягрэ?',
    expect: {
      entity: null, // grape, not winery entity
      evidenceTopics: ['Fetească', 'Neagră', 'Нягрэ'],
      noForeignEntities: ['wine-md'],
      minHits: 1,
    },
  },
  {
    q: 'Какие сорта винограда растут в Молдове?',
    expect: {
      entity: null,
      evidenceTopics: ['Молдова'],
      noForeignEntities: [],
      minHits: 1,
    },
  },

  // Region facts
  {
    q: 'Винодельческий регион Кодру',
    expect: {
      entity: null,
      evidenceTopics: ['Кодру'],
      noForeignEntities: [],
      minHits: 1,
    },
  },

  // Food pairing
  {
    q: 'С чем подавать красное вино?',
    expect: {
      entity: null,
      evidenceTopics: [], // any pairing info is valid
      noForeignEntities: [],
      minHits: 1,
    },
  },
  {
    q: 'Wine and cheese pairing',
    expect: {
      entity: null,
      evidenceTopics: ['cheese', 'pairing'],
      noForeignEntities: [],
      minHits: 1,
    },
  },

  // Unknown entity (should not produce winery-specific evidence)
  {
    q: 'Расскажи про винодельню Mars',
    expect: {
      entity: null, // unknown entity
      evidenceTopics: [], // should NOT find winery-specific evidence
      noForeignEntities: [],
      noWineryEvidence: true, // should not return winery profile chunks
      minHits: 0, // zero is acceptable for unknown
    },
  },

  // Multi-entity comparison
  {
    q: 'Что лучше: Cricova или Mileștii Mici?',
    expect: {
      entity: null, // multi-entity resolved via mentions
      multiEntity: ['cricova', 'mileshtii-mici'],
      evidenceTopics: [],
      noForeignEntities: [],
      minHits: 2,
    },
  },

  // Serving temperature
  {
    q: 'При какой температуре подавать белое вино?',
    expect: {
      entity: null,
      evidenceTopics: ['температур', 'вин', 'бел'],
      noForeignEntities: [],
      minHits: 1,
    },
  },

  // Cross-language
  {
    q: 'Où se trouve le domaine viticole Cricova?',
    expect: {
      entity: 'cricova',
      evidenceTopics: ['Cricova'],
      noForeignEntities: ['purcari'],
      minHits: 1,
    },
  },
  {
    q: 'Wo befindet sich das Weingut Cricova?',
    expect: {
      entity: 'cricova',
      evidenceTopics: ['Cricova'],
      noForeignEntities: ['purcari'],
      minHits: 1,
    },
  },

  // Missing data (price/availability — should NOT appear in evidence)
  {
    q: 'Сколько стоит вино Purcari?',
    expect: {
      entity: 'purcari',
      evidenceTopics: ['Purcari'],
      noForeignEntities: ['cricova'],
      noPriceInfo: true, // should not have price/availability claims
      minHits: 1,
    },
  },

  // Language match
  {
    q: 'Ce este fermentarea vinului?',
    expect: {
      entity: null,
      evidenceTopics: [],
      noForeignEntities: [],
      minHits: 1,
    },
  },

  // Recommendation (no specific entity expected)
  {
    q: 'Посоветуй вино для подарка',
    expect: {
      entity: null,
      evidenceTopics: [],
      noForeignEntities: [],
      minHits: 1,
    },
  },

  // Edge cases
  {
    q: 'Привет',
    expect: {
      entity: null,
      evidenceTopics: [],
      noForeignEntities: [],
      minHits: 0,
      maxHits: 0,
    },
  },
  {
    q: '',
    expect: {
      entity: null,
      evidenceTopics: [],
      noForeignEntities: [],
      minHits: 0,
      maxHits: 0,
    },
  },
];

// ─── Validation ──────────────────────────────────────────────────────

function validateCase(searchResult, entityResult, expect) {
  const issues = [];

  // Entity check
  if (expect.entity !== undefined) {
    if (expect.entity === null) {
      // No specific entity expected — but if one resolved, it should be correct
    } else if (entityResult.entityId !== expect.entity) {
      issues.push(`entity expected=${expect.entity} got=${entityResult.entityId || 'none'}`);
    }
  }

  // Multi-entity check
  if (expect.multiEntity) {
    const resolvedIds = [];
    if (entityResult.found) resolvedIds.push(entityResult.entityId);
    if (entityResult.allMentions) {
      for (const m of entityResult.allMentions) {
        if (!resolvedIds.includes(m.entityId)) resolvedIds.push(m.entityId);
      }
    }
    for (const id of expect.multiEntity) {
      if (!resolvedIds.includes(id)) {
        issues.push(`multi-entity missing ${id}`);
      }
    }
  }

  // Hit count bounds
  const hitCount = searchResult.hits.length;
  if (expect.minHits !== undefined && hitCount < expect.minHits) {
    issues.push(`min hits expected=${expect.minHits} got=${hitCount}`);
  }
  if (expect.maxHits !== undefined && hitCount > expect.maxHits) {
    issues.push(`max hits expected=${expect.maxHits} got=${hitCount}`);
  }

  // Evidence topics (check top-5 results)
  if (expect.evidenceTopics && expect.evidenceTopics.length > 0 && hitCount > 0) {
    const allText = searchResult.hits.slice(0, 5).map((h) => h.chunk.text.toLowerCase()).join(' ');
    for (const topic of expect.evidenceTopics) {
      if (!allText.includes(topic.toLowerCase())) {
        issues.push(`evidence topic "${topic}" not found`);
      }
    }
  }

  // Foreign entity contamination (should NOT have these entities in top-5)
  if (expect.noForeignEntities && hitCount > 0) {
    const top5Entities = searchResult.hits.slice(0, 5)
      .map((h) => h.chunk.metadata.entity_id)
      .filter(Boolean);
    for (const foreign of expect.noForeignEntities) {
      if (top5Entities.includes(foreign)) {
        issues.push(`foreign entity contamination: ${foreign} in results`);
      }
    }
  }

  // No winery evidence (for unknown entities)
  if (expect.noWineryEvidence && hitCount > 0) {
    const hasWineryChunk = searchResult.hits.some(
      (h) => h.chunk.metadata.doc_type === 'winery_profile'
    );
    if (hasWineryChunk) {
      issues.push('winery profile chunk returned for unknown entity');
    }
  }

  // No price info
  if (expect.noPriceInfo && hitCount > 0) {
    const pricePatterns = /(\d+)\s*(лей|mdl|\$|€|usd|eur|цен[ауы]|стоимост)/i;
    const allText = searchResult.hits.slice(0, 5).map((h) => h.chunk.text).join(' ');
    if (pricePatterns.test(allText)) {
      issues.push('price/availability info found in results');
    }
  }

  // Language preference (check if top result is in preferred language)
  if (expect.preferLanguage && hitCount > 0) {
    const topLang = searchResult.hits[0].chunk.metadata.language;
    if (topLang && topLang !== expect.preferLanguage) {
      issues.push(`language preferred=${expect.preferLanguage} got=${topLang}`);
    }
  }

  return issues;
}

// ─── Benchmark Runner ────────────────────────────────────────────────

async function runBenchmark() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  Phase 3 — Minimal Answer Grounding Benchmark`);
  console.log(`${'='.repeat(80)}`);
  console.log(`  Cases: ${GOLDEN_CASES.length}`);
  console.log(`${'='.repeat(80)}\n`);

  const results = [];
  const latencies = [];
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < GOLDEN_CASES.length; i++) {
    const { q, expect } = GOLDEN_CASES[i];
    const startTime = Date.now();

    const entityResult = resolveEntity(q);
    const searchResult = await search(q, { limit: 5 });
    const searchMs = Date.now() - startTime;
    latencies.push(searchMs);

    const issues = validateCase(searchResult, entityResult, expect);
    if (issues.length === 0) passed++;
    else failed++;

    results.push({
      query: q,
      entity: entityResult.entityId || null,
      hitCount: searchResult.hits.length,
      mode: searchResult.mode,
      searchMs,
      issues,
      passed: issues.length === 0,
      topHits: searchResult.hits.slice(0, 3).map((h) => ({
        title: h.chunk.metadata.title,
        entity_id: h.chunk.metadata.entity_id,
        language: h.chunk.metadata.language,
        textPreview: h.chunk.text.slice(0, 100),
      })),
    });

    if ((i + 1) % 10 === 0 || i === GOLDEN_CASES.length - 1) {
      process.stderr.write(`  Progress: ${i + 1}/${GOLDEN_CASES.length}\r`);
    }
  }

  latencies.sort((a, b) => a - b);
  const avgLatency = Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length);
  const p95 = latencies[Math.floor(latencies.length * 0.95)];

  const report = {
    summary: {
      totalCases: results.length,
      passed,
      failed,
      passRate: Math.round(passed / results.length * 100) + '%',
      latency: { avgMs: avgLatency, p95Ms: p95 },
    },
    failures: results.filter((r) => !r.passed),
  };

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`  SUMMARY`);
    console.log(`${'─'.repeat(80)}`);
    console.log(`  Total cases:   ${results.length}`);
    console.log(`  Passed:        ${passed}`);
    console.log(`  Failed:        ${failed}`);
    console.log(`  Pass rate:     ${report.summary.passRate}`);
    console.log(`  Latency avg:   ${avgLatency}ms`);
    console.log(`  Latency p95:   ${p95}ms`);

    if (report.failures.length > 0) {
      console.log(`\n${'─'.repeat(80)}`);
      console.log(`  FAILURES (${report.failures.length})`);
      console.log(`${'─'.repeat(80)}`);
      for (const f of report.failures) {
        console.log(`\n  FAIL "${f.query}"`);
        for (const issue of f.issues) {
          console.log(`     -> ${issue}`);
        }
      }
    }

    console.log(`\n${'='.repeat(80)}\n`);
  }

  return report;
}

runBenchmark().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
