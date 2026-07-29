'use strict';

const fs = require('fs');
const path = require('path');

const ALIASES_FILE = path.join(__dirname, '..', '..', 'knowledge', 'entity-aliases.json');

const MIN_FUZZY_INPUT_LENGTH = 4;
const FUZZY_MATCH_THRESHOLD = 0.7;
const FUZZY_SUGGEST_THRESHOLD = 0.55;
const FUZZY_AMBIGUITY_GAP = 0.05;

// Stage 2: generic wine/grapes terms that must never fuzzy-match to an entity.
// Single-word generic terms (e.g. "wine", "vino") share enough bigrams with
// alias "Wine & D" → "winemd" to cross the Dice threshold — this prevents
// false positives without raising the threshold for legitimate matches.
const GENERIC_WINE_TERMS = new Set([
  'wine', 'wines', 'vino', 'vin', 'вино', 'вина',
  'winery', 'винодельня', 'винодельни',
  'red wine', 'white wine', 'rose wine', 'sparkling wine',
  'redwine', 'whitewine', 'rosewine', 'sparklingwine',
]);

// Check if the normalized input (space-joined or compact) is or contains
// a known generic wine term — prevents fuzzy false positives like "red wine" → wine-md.
function _isGenericWineTerm(input) {
  if (GENERIC_WINE_TERMS.has(input)) return true;
  const tokens = input.split(/\s+/);
  return tokens.some((t) => GENERIC_WINE_TERMS.has(t));
}

const _aliasCacheByPath = new Map();

function _loadAliases(aliasesFile) {
  const filePath = aliasesFile || ALIASES_FILE;
  if (_aliasCacheByPath.has(filePath)) return _aliasCacheByPath.get(filePath);
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  _aliasCacheByPath.set(filePath, data);
  return data;
}

function _normalizeForCompare(str) {
  return str
    .toLowerCase()
    .replace(/['"«»]/g, '')
    .replace(/[.\-]/g, '')
    .replace(/\s+/g, '')
    .replace(/&/g, 'and');
}

function diceCoefficient(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.substring(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.substring(i, i + 2);
    const count = bigrams.get(bg) || 0;
    if (count > 0) {
      bigrams.set(bg, count - 1);
      intersection++;
    }
  }
  return (2 * intersection) / (a.length + b.length - 2 || 1);
}

function normalizeEntityName(input) {
  const original = String(input || '').trim();
  if (!original) return { original, normalized: '', variants: [] };

  const lower = original.toLowerCase();
  let base = lower;
  base = base.replace(/['"«»]/g, '');
  base = base.replace(/&/g, ' and ');
  base = base.replace(/\./g, ' ').replace(/-/g, ' ');

  const noSpaces = base.replace(/\s+/g, '');

  // Also produce a "stripped" variant: remove &, ., - and all spaces
  const stripped = lower.replace(/[&.\-]/g, '').replace(/\s+/g, '');

  const variants = new Set();
  variants.add(lower);
  variants.add(noSpaces);
  variants.add(base.replace(/\s+/g, ' ').trim());
  variants.add(lower.replace(/&/g, 'and').replace(/\s+/g, ''));
  variants.add(stripped);
  variants.add(lower.replace(/['"«»]/g, '').replace(/[.\-&]/g, ' ').replace(/\s+/g, ' '));

  if (lower.includes('&')) {
    variants.add(lower.replace(/&/g, 'and'));
    variants.add(lower.replace(/&/g, '').replace(/\s+/g, ' ').trim());
    variants.add(lower.replace(/\s*&\s*/g, ' ').replace(/\s+/g, ' ').trim());
    variants.add(lower.replace(/&/g, ' ').replace(/\s+/g, ' ').trim());
  }
  if (lower.includes('.')) {
    variants.add(lower.replace(/\./g, '').replace(/\s+/g, ' ').trim());
    variants.add(lower.replace(/\./g, ' ').replace(/\s+/g, ' ').trim());
  }
  if (lower.includes('-')) {
    variants.add(lower.replace(/-/g, ' ').replace(/\s+/g, ' ').trim());
  }
  if (/\s/.test(lower)) {
    variants.add(lower.replace(/\s+/g, ''));
  }

  return {
    original,
    normalized: noSpaces,
    variants: [...variants].filter(Boolean),
  };
}

// Unicode-aware word-boundary check: ensures alias match is at a word boundary
// in the input. Uses lookaround for Unicode letters/digits (\p{L}\p{N}).
function _isWordBoundaryMatch(inputLower, aliasLower) {
  const idx = inputLower.indexOf(aliasLower);
  if (idx === -1) return false;
  const before = idx > 0 ? inputLower[idx - 1] : ' ';
  const afterIdx = idx + aliasLower.length;
  const after = afterIdx < inputLower.length ? inputLower[afterIdx] : ' ';
  const wordChar = /[\p{L}\p{N}]/u;
  const beforeIsWord = wordChar.test(before);
  const afterIsWord = wordChar.test(after);
  // Match if alias is at a word boundary (not surrounded by word characters)
  return !beforeIsWord || !afterIsWord;
}

// Find all entity mentions in input using word-boundary-aware matching.
// Returns array of { entity, matchedAlias } sorted by alias length (longest first).
function _extractEntityMentions(input, entities) {
  const inputLower = input.toLowerCase();
  const matches = [];

  for (const entity of entities) {
    for (const { alias } of entity.aliases) {
      const aliasLower = alias.toLowerCase();
      if (aliasLower.length < 2) continue;
      if (_isWordBoundaryMatch(inputLower, aliasLower)) {
        matches.push({ entity, matchedAlias: alias, len: aliasLower.length });
      }
    }
  }

  // Sort by alias length descending — longest match first
  matches.sort((a, b) => b.len - a.len);

  // Deduplicate: once an entity is matched, skip shorter aliases for the same entity
  const seenEntities = new Set();
  const deduped = [];
  for (const m of matches) {
    if (seenEntities.has(m.entity.entityId)) continue;
    seenEntities.add(m.entity.entityId);
    deduped.push({ entity: m.entity, matchedAlias: m.matchedAlias });
  }

  return deduped;
}

// Resolve ALL entities mentioned in the input. Returns array of matches.
// Options:
//   - includeSuggestions: if true, also returns medium-confidence fuzzy matches
//     as `suggestions` (requires_confirmation: true).
function resolveEntities(input, options = {}) {
  const { aliasesFile, includeSuggestions = false } = options;
  const { original, normalized, variants } = normalizeEntityName(input);
  if (!original) return [];

  const entities = _loadAliases(aliasesFile);
  const normalizedVariants = new Set(variants.map(_normalizeForCompare));

  const matches = [];
  // Track best fuzzy candidate per entity for suggestions
  const bestFuzzyByEntity = new Map();

  for (const entity of entities) {
    let bestAlias = null;
    let bestConfidence = 0;
    let bestMatchType = null;
    let bestSuggestionAlias = null;
    let bestSuggestionConfidence = 0;

    for (const { alias } of entity.aliases) {
      const aliasNorm = _normalizeForCompare(alias);
      const aliasLower = alias.toLowerCase();

      // Exact match (case-sensitive full input)
      if (aliasLower === original.toLowerCase()) {
        if (1.0 > bestConfidence) {
          bestAlias = alias; bestConfidence = 1.0; bestMatchType = 'exact';
        }
        continue;
      }

      // Normalized match (after stripping punctuation/spaces)
      if (normalizedVariants.has(aliasNorm)) {
        if (0.9 > bestConfidence) {
          bestAlias = alias; bestConfidence = 0.9; bestMatchType = 'normalized';
        }
        continue;
      }

      // Fuzzy match (Dice coefficient) — only if input is long enough
      // and not a known generic wine term (prevents false positives like
      // "wine" → wine-md).
      if (normalized.length >= MIN_FUZZY_INPUT_LENGTH && !_isGenericWineTerm(normalized)) {
        const dice = diceCoefficient(aliasNorm, normalized);
        if (dice >= FUZZY_MATCH_THRESHOLD && dice > bestConfidence) {
          bestAlias = alias; bestConfidence = Math.round(dice * 100) / 100; bestMatchType = 'fuzzy';
        } else if (includeSuggestions && dice >= FUZZY_SUGGEST_THRESHOLD && dice > bestSuggestionConfidence) {
          bestSuggestionAlias = alias;
          bestSuggestionConfidence = Math.round(dice * 100) / 100;
        }
      }
    }

    if (bestAlias) {
      matches.push({ entity, alias: bestAlias, confidence: bestConfidence, matchType: bestMatchType });
    } else if (includeSuggestions && bestSuggestionAlias && bestSuggestionConfidence >= FUZZY_SUGGEST_THRESHOLD) {
      // Track as suggestion only — not a confirmed match
      bestFuzzyByEntity.set(entity.entityId, {
        entity,
        alias: bestSuggestionAlias,
        confidence: bestSuggestionConfidence,
        matchType: 'fuzzy_suggestion',
      });
    }
  }

  // Sort by confidence descending
  matches.sort((a, b) => b.confidence - a.confidence);

  // Ambiguity check: if top two are within gap, reject both
  if (matches.length > 1) {
    const gap = matches[0].confidence - matches[1].confidence;
    if (gap < FUZZY_AMBIGUITY_GAP) {
      console.log('[entityResolver] ambiguous match for "%s": %s (%s) vs %s (%s) gap=%s',
        original, matches[0].entity.entityId, matches[0].confidence, matches[1].entity.entityId, matches[1].confidence, gap.toFixed(3));
      return [];
    }
  }

  const resolved = matches.map((m) => ({
    found: true,
    entityId: m.entity.entityId,
    canonicalName: m.entity.canonicalName,
    matchedAlias: m.alias,
    matchType: m.matchType,
    confidence: m.confidence,
  }));

  // Attach suggestions if requested and no exact/normalized match was found
  if (includeSuggestions && resolved.length === 0 && bestFuzzyByEntity.size > 0) {
    const suggestions = [...bestFuzzyByEntity.values()]
      .sort((a, b) => b.confidence - a.confidence)
      .map((s) => ({
        entityId: s.entity.entityId,
        canonicalName: s.entity.canonicalName,
        matchedAlias: s.alias,
        confidence: s.confidence,
        requires_confirmation: true,
      }));
    return [{ found: false, suggestions }];
  }

  return resolved;
}

// Backward-compatible: resolve exactly one entity.
// Returns single match only if unambiguous; otherwise found=false.
// Options:
//   - includeSuggestions: if true, includes medium-confidence fuzzy suggestions
//     when no exact/normalized match is found.
function resolveEntity(input, options = {}) {
  const all = resolveEntities(input, options);

  if (all.length === 0) {
    // Try mention extraction as fallback for natural-language queries
    const entities = _loadAliases(options.aliasesFile);
    const mentions = _extractEntityMentions(input, entities);
    if (mentions.length === 1) {
      console.log('[entityResolver] extracted mention "%s" from "%s" -> entity=%s',
        mentions[0].matchedAlias, input, mentions[0].entity.entityId);
      return {
        found: true,
        entityId: mentions[0].entity.entityId,
        canonicalName: mentions[0].entity.canonicalName,
        matchedAlias: mentions[0].matchedAlias,
        matchType: 'mention_extract',
        confidence: 0.85,
      };
    }
    if (mentions.length > 1) {
      // Multiple mentions — return first (longest alias), but mark as multi-entity
      console.log('[entityResolver] multiple mentions in "%s": %s',
        input, mentions.map((m) => m.entity.entityId).join(', '));
      return {
        found: true,
        entityId: mentions[0].entity.entityId,
        canonicalName: mentions[0].entity.canonicalName,
        matchedAlias: mentions[0].matchedAlias,
        matchType: 'mention_extract',
        confidence: 0.85,
        allMentions: mentions.map((m) => ({
          entityId: m.entity.entityId,
          canonicalName: m.entity.canonicalName,
          matchedAlias: m.matchedAlias,
        })),
      };
    }
    // Stage 2: if no entity found but activeEntity context is set, resolve
    // to the context entity for follow-up queries.
    if (options.contextEntity) {
      const entities = _loadAliases(options.aliasesFile);
      const ctxEntity = entities.find((e) => e.entityId === options.contextEntity);
      if (ctxEntity) {
        console.log('[entityResolver] context resolve "%s" -> entity=%s',
          input, ctxEntity.entityId);
        return {
          found: true,
          entityId: ctxEntity.entityId,
          canonicalName: ctxEntity.canonicalName,
          matchedAlias: null,
          matchType: 'context_resolve',
          confidence: 0.85,
        };
      }
    }
    return { found: false, entityId: null, canonicalName: null, matchedAlias: null, matchType: null, confidence: 0 };
  }

  if (all.length === 1) {
    const m = all[0];
    // If resolveEntities returned suggestions only (found=false), also try mention extraction
    // so that multi-entity queries work correctly even with includeSuggestions=true.
    if (!m.found && m.suggestions) {
      const entities = _loadAliases(options.aliasesFile);
      const mentions = _extractEntityMentions(input, entities);
      if (mentions.length > 0) {
        console.log('[entityResolver] suggestions + mention extraction in "%s": %s',
          input, mentions.map((x) => x.entity.entityId).join(', '));
        return {
          found: true,
          entityId: mentions[0].entity.entityId,
          canonicalName: mentions[0].entity.canonicalName,
          matchedAlias: mentions[0].matchedAlias,
          matchType: 'mention_extract',
          confidence: 0.85,
          allMentions: mentions.map((x) => ({
            entityId: x.entity.entityId,
            canonicalName: x.entity.canonicalName,
            matchedAlias: x.matchedAlias,
          })),
          suggestions: m.suggestions,
        };
      }
    }
    console.log('[entityResolver] resolved "%s" -> entity=%s matchType=%s confidence=%s',
      input, m.entityId, m.matchType, m.confidence);
    return m;
  }

  // Multiple distinct entities matched via aliases (e.g. "Purcari Cricova")
  console.log('[entityResolver] multiple entities in "%s": %s',
    input, all.map((m) => m.entityId).join(', '));
  return {
    ...all[0],
    allMentions: all.map((m) => ({
      entityId: m.entityId,
      canonicalName: m.canonicalName,
      matchedAlias: m.matchedAlias,
    })),
  };
}

function getAliasesForEntity(entityId, options = {}) {
  const { aliasesFile } = options;
  const entities = _loadAliases(aliasesFile);
  const entity = entities.find((e) => e.entityId === entityId);
  if (!entity) return [];
  const seen = new Set();
  return entity.aliases.filter((a) => {
    const key = a.alias.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((a) => a.alias);
}

function buildAliasContext(resolved, options = {}) {
  if (!resolved || !resolved.found) return null;
  const allAliases = getAliasesForEntity(resolved.entityId, options);
  const uniqueAliases = [...new Set(allAliases.map((a) => a.toLowerCase()))]
    .map((low) => allAliases.find((a) => a.toLowerCase() === low))
    .filter(Boolean);

  const parts = [`Entity: ${resolved.canonicalName} (${resolved.entityId})`];
  if (uniqueAliases.length > 0) {
    parts.push(`Also known as: ${uniqueAliases.join(', ')}`);
  }
  if (resolved.matchedAlias && resolved.matchedAlias !== resolved.canonicalName) {
    parts.push(`User query "${resolved.matchedAlias}" resolved to entity "${resolved.canonicalName}"`);
  }
  return parts.join('\n');
}

function findByEntityId(entityId, options = {}) {
  const { aliasesFile } = options;
  const entities = _loadAliases(aliasesFile);
  return entities.find((e) => e.entityId === entityId) || null;
}

function getAllEntityIds(options = {}) {
  const { aliasesFile } = options;
  const entities = _loadAliases(aliasesFile);
  return entities.map((e) => e.entityId);
}

module.exports = {
  normalizeEntityName,
  resolveEntity,
  resolveEntities,
  getAliasesForEntity,
  buildAliasContext,
  findByEntityId,
  getAllEntityIds,
};
