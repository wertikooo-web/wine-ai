'use strict';

const fs = require('fs');
const path = require('path');

const ALIASES_FILE = path.join(__dirname, '..', '..', 'knowledge', 'entity-aliases.json');

const MIN_FUZZY_INPUT_LENGTH = 4;
const FUZZY_MATCH_THRESHOLD = 0.7;
const FUZZY_AMBIGUITY_GAP = 0.05;

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

  const variants = new Set();
  variants.add(lower);
  variants.add(noSpaces);
  variants.add(base.replace(/\s+/g, ' ').trim());
  variants.add(lower.replace(/&/g, 'and').replace(/\s+/g, ''));
  variants.add(lower.replace(/['"«»]/g, '').replace(/[.\-&]/g, ' ').replace(/\s+/g, ''));

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

function _extractEntityMention(input, entities) {
  const inputLower = input.toLowerCase();
  let bestAlias = null;
  let bestEntity = null;
  let bestLen = 0;

  for (const entity of entities) {
    for (const { alias } of entity.aliases) {
      const aliasLower = alias.toLowerCase();
      if (aliasLower.length < 2) continue;
      if (inputLower.includes(aliasLower) && aliasLower.length > bestLen) {
        bestAlias = alias;
        bestEntity = entity;
        bestLen = aliasLower.length;
      }
    }
  }

  return bestEntity ? { entity: bestEntity, matchedAlias: bestAlias } : null;
}

function resolveEntity(input, options = {}) {
  const { aliasesFile } = options;
  const { original, normalized, variants } = normalizeEntityName(input);
  if (!original) {
    return { found: false, entityId: null, canonicalName: null, matchedAlias: null, matchType: null, confidence: 0 };
  }

  const entities = _loadAliases(aliasesFile);
  const normalizedVariants = new Set(variants.map(_normalizeForCompare));

  const matches = [];

  for (const entity of entities) {
    let bestAlias = null;
    let bestConfidence = 0;
    let bestMatchType = null;

    for (const { alias } of entity.aliases) {
      const aliasNorm = _normalizeForCompare(alias);
      const aliasLower = alias.toLowerCase();

      if (aliasLower === original.toLowerCase()) {
        if (1.0 > bestConfidence) {
          bestAlias = alias; bestConfidence = 1.0; bestMatchType = 'exact';
        }
        continue;
      }

      if (normalizedVariants.has(aliasNorm)) {
        if (0.9 > bestConfidence) {
          bestAlias = alias; bestConfidence = 0.9; bestMatchType = 'normalized';
        }
        continue;
      }

      if (normalized.length >= MIN_FUZZY_INPUT_LENGTH) {
        const dice = diceCoefficient(aliasNorm, normalized);
        if (dice >= FUZZY_MATCH_THRESHOLD && dice > bestConfidence) {
          bestAlias = alias; bestConfidence = Math.round(dice * 100) / 100; bestMatchType = 'fuzzy';
        }
      }
    }

    if (!bestAlias) {
      const entityNorm = entity.entityId.toLowerCase().replace(/['"«»]/g, '').replace(/[.\-]/g, '');
      for (const variant of normalizedVariants) {
        if (entityNorm.includes(variant) || variant.includes(entityNorm)) {
          if (0.7 > bestConfidence) {
            bestAlias = original; bestConfidence = 0.7; bestMatchType = 'normalized';
          }
          break;
        }
      }
    }

    if (bestAlias) {
      matches.push({ entity, alias: bestAlias, confidence: bestConfidence, matchType: bestMatchType });
    }
  }

  if (matches.length === 0) {
    const mention = _extractEntityMention(original, entities);
    if (mention) {
      console.log('[entityResolver] extracted mention "%s" from "%s" -> entity=%s',
        mention.matchedAlias, original, mention.entity.entityId);
      return {
        found: true,
        entityId: mention.entity.entityId,
        canonicalName: mention.entity.canonicalName,
        matchedAlias: mention.matchedAlias,
        matchType: 'mention_extract',
        confidence: 0.85,
      };
    }
    return { found: false, entityId: null, canonicalName: null, matchedAlias: null, matchType: null, confidence: 0 };
  }

  matches.sort((a, b) => b.confidence - a.confidence);
  const best = matches[0];

  if (matches.length > 1) {
    const gap = matches[0].confidence - matches[1].confidence;
    if (gap < FUZZY_AMBIGUITY_GAP) {
      console.log('[entityResolver] ambiguous match for "%s": %s (%s) vs %s (%s) gap=%s',
        original, matches[0].entity.entityId, matches[0].confidence, matches[1].entity.entityId, matches[1].confidence, gap.toFixed(3));
      return { found: false, entityId: null, canonicalName: null, matchedAlias: null, matchType: null, confidence: 0, ambiguous: true };
    }
  }

  console.log('[entityResolver] resolved "%s" -> entity=%s matchType=%s confidence=%s',
    original, best.entity.entityId, best.matchType, best.confidence);

  return {
    found: true,
    entityId: best.entity.entityId,
    canonicalName: best.entity.canonicalName,
    matchedAlias: best.alias,
    matchType: best.matchType,
    confidence: best.confidence,
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
  getAliasesForEntity,
  buildAliasContext,
  findByEntityId,
  getAllEntityIds,
};
