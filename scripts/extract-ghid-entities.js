'use strict';
/**
 * One-off extraction helper: enumerate producer cards from the Ghid Vin-Divin book.
 * Source of truth for the entity LIST is the book's own table of contents
 * (lines with "Name .... page"); body text is used only to attach address /
 * website / region when unambiguously locatable.
 *
 * Output: scripts/ghid-extraction.json (working artifact, not the registry).
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'knowledge', 'source', 'Ghid_Vin-Divin_Moldova__ro_en__7__Print.md');
const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);

// Non-producer TOC entries (editorial / thematic chapters), RO + EN.
const NON_PRODUCER = new Set([
  'Moldova, la un pahar de vin', 'Vremea Vinului', 'Vinurile Moldovei',
  'Soiurile Autohtone', 'Soiuri de selecție Moldovenești',
  'Vinurile de autor ale Moldovei', '7000 de ani sub vin',
  'Moldova true a glass of wine', 'Wine Time', 'Wine regions',
  'Autochthonous varieties', 'National breeding varieties',
  "Author's wines from small wineries", '7000 Years under Wine',
  'Cuprins / Contents',
]);

const toc = [];
lines.forEach((l, idx) => {
  const m = l.match(/^\s*(\S.*?)\s*\.{3,}\s*(\d+)\s*$/);
  if (!m) return;
  const name = m[1].replace(/\s+/g, ' ').trim();
  if (name === '.' || name.length < 3) return;           // EN-column page-number debris
  if (NON_PRODUCER.has(name.replace(/’/g, "'"))) return; // chapters
  toc.push({ name, page: Number(m[2]), tocLine: idx + 1 });
});

// Page markers: "-- N of 204 --" appear AFTER the content of PDF page N.
const pageOfLine = new Array(lines.length).fill(null);
{
  let cur = 1;
  for (let i = 0; i < lines.length; i++) {
    pageOfLine[i] = cur;
    const m = lines[i].match(/^-- (\d+) of 204 --$/);
    if (m) cur = Number(m[1]) + 1;
  }
}

function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ș/g, 's').replace(/ț/g, 't').replace(/Ș/g, 'S').replace(/Ț/g, 'T');
}
const norm = (s) => stripDiacritics(String(s)).toLowerCase().replace(/[^a-z0-9]/g, '');

// Locate each producer's card: the body line equal to its name, nearest to the
// TOC page number (book page numbering is offset from PDF page numbering).
const FIELD = {
  address: /^\s*Adresa:\s*(.+)$/,
  website: /(www\.[^\s]+|[a-z0-9-]+\.md\b|facebook\.com\/[^\s]+)/i,
  winemaker: /^\s*Vinificator:\s*(.+)$/,
  founded: /^\s*Anul înființării:\s*(\d{4})/,
  yearHa: /^\s*(\d{4})\s*\/\s*([\d.,]+)\s*(?:de\s*)?hectare/,
  capacity: /^\s*(?:Capacitate|Producție):\s*(.+)$/,
  vineyard: /^\s*Suprafața podgoriei:\s*(.+)$/,
  region: /^\s*(?:Zona vitivinicolă|Regiunea de vinificare)\s*:\s*(.+)$/,
  phone: /^\s*\+373\s*[\d\s]+$/,
  email: /^\s*[\w.+-]+@[\w.-]+\.\w+\s*$/,
};

const results = [];
for (const t of toc) {
  const target = norm(t.name);
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    if (i + 1 <= 300) continue; // skip TOC region
    if (norm(lines[i]) !== target) continue;
    const d = Math.abs(pageOfLine[i] - t.page);
    if (!best || d < best.d) best = { line: i, d };
  }
  const rec = {
    tocName: t.name, tocPage: t.page,
    bodyLine: best ? best.line + 1 : null,
    pdfPage: best ? pageOfLine[best.line] : null,
    fields: {},
  };
  if (best) {
    // In this PDF text dump each card's field block sits IMMEDIATELY BEFORE its
    // name line (verified against Château Vartely / Crama Mircești / Dénovie).
    // Walk backwards, accepting only field-shaped or numeric-noise lines, and
    // stop at the first prose line — anything past that belongs to another card.
    for (let i = best.line - 1; i >= Math.max(0, best.line - 22); i--) {
      const L = lines[i];
      if (/^-- \d+ of 204 --$/.test(L)) break;
      let hit = false;
      for (const [k, re] of Object.entries(FIELD)) {
        const m = L.match(re);
        if (m) { hit = true; if (!rec.fields[k]) rec.fields[k] = (m[1] || m[0]).trim(); }
      }
      if (hit) continue;
      // Layout noise tolerated inside a field block: distance badges, page numbers,
      // blank lines, and running heads.
      if (/^\s*$/.test(L) || /^\s*\d{1,3}\s*$/.test(L) || /^\s*km\s*$/.test(L)
        || /GHIDUL VINULUI|WINE GUIDE/.test(L)) continue;
      break; // prose — end of this card's field block
    }
  }
  results.push(rec);
}

fs.writeFileSync(path.join(__dirname, 'ghid-extraction.json'), JSON.stringify(results, null, 2), 'utf8');
console.log('TOC producer entries:', toc.length);
console.log('located in body:', results.filter((r) => r.bodyLine).length);
console.log('NOT located:', results.filter((r) => !r.bodyLine).map((r) => r.tocName).join(', '));
const seen = new Map();
for (const r of results) {
  const k = norm(r.tocName);
  seen.set(k, (seen.get(k) || 0) + 1);
}
console.log('duplicate TOC names:', [...seen].filter(([, c]) => c > 1).map(([k]) => k).join(', ') || 'none');
