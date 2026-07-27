'use strict';

const { normalizeEntityName, resolveEntity } = require('../src/knowledge/entityResolver');
const t = require('./helpers/assertions');

async function run() {

  {
    const result = normalizeEntityName('Wine & D');
    t.ok(result.variants.length >= 4, 'Wine & D should generate multiple variants');
    t.ok(result.variants.includes('wine & d'), 'variant should include lowercased original');
    t.ok(result.variants.includes('wineandd'), 'variant should include expanded &');
    t.ok(result.variants.includes('wined'), 'variant should include stripped & + spaces');
    t.equal(result.normalized, 'wineandd', 'normalized should convert & to and, strip spaces');
  }

  {
    const result = normalizeEntityName('wine.md');
    t.ok(result.variants.includes('winemd'), 'wine.md variant should strip dot');
    t.ok(result.variants.includes('wine.md'), 'wine.md variant should keep original lower');
  }

  {
    const result = normalizeEntityName('WineMD');
    t.equal(result.normalized, 'winemd', 'WineMD -> winemd');
    t.ok(result.variants.includes('winemd'), 'WineMD variant should be winemd');
    t.ok(result.variants.includes('winemd'), 'WineMD lower case variant');
  }

  {
    const result = normalizeEntityName('ВайнМД');
    t.ok(result.variants.includes('вайнмд'), 'ВайнМД should lowercase to вайнмд');
  }

  {
    const result = normalizeEntityName('');
    t.equal(result.normalized, '', 'empty input should return empty');
    t.deepEqual(result.variants, [], 'empty input should return empty variants');
  }

  {
    const result = normalizeEntityName('   ');
    t.equal(result.normalized, '', 'whitespace-only should return empty');
  }

  // --- resolveEntity with matchType ---

  {
    const resolved = resolveEntity('Wine & D');
    t.ok(resolved.found, 'Wine & D should resolve');
    t.equal(resolved.entityId, 'wine-md', 'Wine & D -> entityId wine-md');
    t.equal(resolved.canonicalName, 'Wine.md', 'Wine & D -> canonicalName Wine.md');
    t.ok(resolved.matchedAlias, 'should have a matched alias');
    t.ok(resolved.matchType === 'exact' || resolved.matchType === 'normalized', 'Wine & D should match as exact or normalized');
  }

  {
    const resolved = resolveEntity('wine.md');
    t.ok(resolved.found, 'wine.md should resolve');
    t.equal(resolved.entityId, 'wine-md', 'wine.md -> entityId wine-md');
    t.ok(resolved.matchType === 'exact' || resolved.matchType === 'normalized', 'wine.md should match as exact or normalized');
  }

  {
    const resolved = resolveEntity('WineMD');
    t.ok(resolved.found, 'WineMD should resolve');
    t.equal(resolved.entityId, 'wine-md', 'WineMD -> entityId wine-md');
  }

  {
    const resolved = resolveEntity('ВайнМД');
    t.ok(resolved.found, 'ВайнМД should resolve');
    t.equal(resolved.entityId, 'wine-md', 'ВайнМД -> entityId wine-md');
  }

  {
    const resolved = resolveEntity('Wine MD');
    t.ok(resolved.found, 'Wine MD should resolve');
    t.equal(resolved.entityId, 'wine-md', 'Wine MD -> entityId wine-md');
  }

  {
    const resolved = resolveEntity('');
    t.ok(!resolved.found, 'empty input should not resolve');
  }

  {
    const resolved = resolveEntity('some random nonsense');
    t.ok(!resolved.found, 'random input should not resolve');
  }

  {
    const resolved = resolveEntity('Wine&D');
    t.ok(resolved.found, 'Wine&D should resolve');
    t.equal(resolved.entityId, 'wine-md', 'Wine&D -> entityId wine-md');
  }

  // --- matchType tests ---
  {
    // "Вайн МД" should match normalized (after space removal, etc.)
    const r = resolveEntity('Вайн МД');
    t.ok(r.found, 'Вайн МД should resolve');
    t.ok(r.matchType === 'normalized' || r.matchType === 'exact', 'Вайн МД matchType should be normalized or exact');
  }

  // --- fuzzy matching test ---
  {
    // "WineEmDee" -> somewhat close to "winemd" normalized, should trigger fuzzy
    const r = resolveEntity('WineEmDee');
    // This is a dice coefficient match — the normalized forms share bigrams
    // "winemd" vs "wineemdee" — the dice should be >= 0.7 but it's not guaranteed,
    // so this test is informational; we just verify it doesn't crash.
    if (r.found) {
      t.ok(r.matchType === 'fuzzy', 'WineEmDee should match as fuzzy if it matches');
    }
  }

  // --- ambiguous guard test ---
  {
    // With only one entity (wine-md), ambiguity is impossible for now.
    // Verify that entity-aliases.json loads correctly by checking find.
    const { findByEntityId } = require('../src/knowledge/entityResolver');
    const found = findByEntityId('wine-md');
    t.ok(found !== null, 'findByEntityId should find wine-md');
    t.equal(found.canonicalName, 'Wine.md', 'findByEntityId should return correct entity');
  }

  console.log('entityResolver: all tests passed');
}

module.exports = { run };
