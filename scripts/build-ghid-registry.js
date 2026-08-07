'use strict';
/**
 * Merge Ghid Vin-Divin producer cards into knowledge/entity-aliases.json.
 *
 * Scope: ENTITY registry only — canonical name, conservative aliases, source
 * locator. Address / winemaker / capacity are deliberately NOT imported: in this
 * PDF text dump the per-card field blocks cannot be reliably attributed (two
 * column layout, extraction order varies per page). They are entity_facts
 * material anyway (see the entity_facts proposal), not registry fields.
 *
 * Alias policy this round (conservative, per sprint brief):
 *   - the book's own spelling
 *   - a diacritic-stripped variant (covers Vinăria->Vinaria, Château->Chateau)
 *   - the base name with a trailing "Winery"/"Wine"/"Wines" descriptor dropped
 *   - nothing else. No speculative ASR / Cyrillic transliteration this pass.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REG = path.join(ROOT, 'knowledge', 'entity-aliases.json');
const cards = require('./ghid-extraction.json');

const registry = JSON.parse(fs.readFileSync(REG, 'utf8'));

function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ș/g, 's').replace(/ț/g, 't').replace(/Ș/g, 'S').replace(/Ț/g, 'T')
    .replace(/ă/g, 'a').replace(/î/g, 'i').replace(/â/g, 'a')
    .replace(/Ă/g, 'A').replace(/Î/g, 'I').replace(/Â/g, 'A');
}
const key = (s) => stripDiacritics(String(s)).toLowerCase().replace(/[^a-z0-9]/g, '');
const slug = (s) => stripDiacritics(String(s)).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---- index what the registry already knows (canonical names + every alias) ----
const existingByKey = new Map();
for (const e of registry) {
  existingByKey.set(key(e.canonicalName), e);
  for (const a of e.aliases) if (!existingByKey.has(key(a.alias))) existingByKey.set(key(a.alias), e);
}

// Explicit brand -> existing entityId links where the book's name differs from
// the registry's canonical form. Hand-verified, one line of evidence each.
const EXPLICIT_LINKS = {
  'chateaupurcari': 'purcari',       // book prints the full brand "Chateau Purcari"
  'fautorwinery': 'fautor',
  'gitanawinery': 'gitana',
  'asconiwinery': 'asconi',
  'basavinwinery': 'basavin',
  'bulgariwinery': 'bulgari',
  'milestiimici': 'mileshtii-mici',  // registry entityId uses an older translit slug
};

// Distinct companies whose names collide on a shared token — never merge these.
const KEEP_DISTINCT = new Set(['timbruspurcariestate']);

const added = [];
const matchedExisting = [];
const needsReview = [];
const seenNew = new Map();

function aliasSet(name) {
  const out = new Set([name]);
  const bare = stripDiacritics(name);
  if (bare !== name) out.add(bare);
  const base = name.replace(/\s+(Winery|Wines|Wine)$/i, '').trim();
  if (base && base !== name && base.length >= 4) {
    out.add(base);
    const bareBase = stripDiacritics(base);
    if (bareBase !== base) out.add(bareBase);
  }
  return [...out];
}

for (const c of cards) {
  const name = c.tocName;
  const k = key(name);

  if (KEEP_DISTINCT.has(k)) {
    // fall through to creation, but flag so a human confirms the split
    needsReview.push({ name, reason: 'shares a token with an existing distinct entity (Purcari) — kept separate deliberately' });
  } else {
    const linkedId = EXPLICIT_LINKS[k];
    const hit = linkedId ? registry.find((e) => e.entityId === linkedId) : existingByKey.get(k);
    if (hit) {
      // enrich existing entity with the book's spelling if new
      const have = new Set(hit.aliases.map((a) => key(a.alias)));
      const fresh = aliasSet(name).filter((a) => !have.has(key(a)));
      for (const a of fresh) hit.aliases.push({ alias: a, lang: 'ro' });
      hit.sources = [...new Set([...(hit.sources || []), `Ghid Vin-Divin Moldova 2023, p.${c.tocPage}`])];
      matchedExisting.push({ name, entityId: hit.entityId, addedAliases: fresh });
      continue;
    }
  }

  // duplicate within the book itself (e.g. Vinăria Ungheni listed in both the
  // wine and the divin section) — same normalized name, same company
  if (seenNew.has(k)) {
    const prev = seenNew.get(k);
    prev.sources.push(`Ghid Vin-Divin Moldova 2023, p.${c.tocPage}`);
    matchedExisting.push({ name, entityId: prev.entityId, addedAliases: [], intraBookDuplicate: true });
    continue;
  }

  const entity = {
    entityId: slug(name),
    entityType: c.tocPage >= 100 ? 'divin-producer' : 'winery',
    canonicalName: name,
    description: `${name} — производитель ${c.tocPage >= 100 ? 'дивинов' : 'вин'} Республики Молдова (Ghid Vin-Divin Moldova 2023)`,
    sources: [`Ghid Vin-Divin Moldova 2023, p.${c.tocPage}`],
    aliases: aliasSet(name).map((a) => ({ alias: a, lang: 'ro' })),
  };
  registry.push(entity);
  seenNew.set(k, entity);
  added.push(entity.entityId);
}

fs.writeFileSync(REG, JSON.stringify(registry, null, 2) + '\n', 'utf8');

const byType = {};
let aliasCount = 0;
for (const e of registry) { byType[e.entityType] = (byType[e.entityType] || 0) + 1; aliasCount += e.aliases.length; }
console.log('entities now:', registry.length, byType);
console.log('aliases now:', aliasCount);
console.log('new entities:', added.length);
console.log('matched existing:', matchedExisting.length);
matchedExisting.forEach((m) => console.log('  =', m.name, '->', m.entityId, m.intraBookDuplicate ? '(intra-book dup)' : `+${m.addedAliases.length} aliases`));
console.log('needs_review:', needsReview.length);
needsReview.forEach((n) => console.log('  ?', n.name, '--', n.reason));
