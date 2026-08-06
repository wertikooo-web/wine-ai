'use strict';

const crypto = require('crypto');
const db = require('../../knowledge/db');
const { safeFetchResource } = require('../sources/safeHttpClient');

const MAX_SOURCE_CHARS = 48000;
const id = () => `wine_${crypto.randomBytes(8).toString('hex')}`;
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const unique = (items) => [...new Set(items.map(clean).filter(Boolean))];

function between(text, expressions) {
    for (const expression of expressions) {
        const match = text.match(expression);
        if (match && clean(match[1])) return clean(match[1]);
    }
    return null;
}

function inferProfile({ name, sourceText }) {
    const text = `${name} ${sourceText}`.toLocaleLowerCase();
    const grapes = unique([...text.matchAll(/(?:feteasc[ăa] (?:neagr[ăa]|alb[ăa]|regal[ăa])|viorica|rar[ăa] neagr[ăa]|sauvignon blanc|cabernet sauvignon|merlot|pinot noir|chardonnay)/giu)].map((m) => m[0]));
    const color = /(rose|rosé|розов)/u.test(text) ? 'rose' : /(spumant|sparkling|brut|игрист)/u.test(text) ? 'sparkling' : /(roșu|rosu|red|красн)/u.test(text) ? 'red' : 'white';
    const sweetness = /(demidulce|semi-dry|semi dry|off-dry|полусух)/u.test(text) ? 2 : /(dulce|sweet|сладк)/u.test(text) ? 3 : 1;
    const body = color === 'red' ? 3 : color === 'rose' ? 2 : 1;
    const acidity = /(sauvignon|viorica|citrus|citric|lămâi|лимон)/u.test(text) ? 4 : 3;
    const tannin = color === 'red' ? (/(cabernet|feteasc[ăa] neagr|fetească neagră)/u.test(text) ? 3 : 2) : 0;
    const notes = unique([...text.matchAll(/(?:cireș|cherry|vișin|blackberry|mure|citrus|floral|flori|vanil|pepper|piper|яблок|apple)/giu)].map((m) => m[0]));
    const foods = color === 'red' ? ['beef', 'lamb', 'mushroom', 'aged_cheese'] : color === 'rose' ? ['charcuterie', 'poultry', 'grilled_vegetable', 'spicy'] : color === 'sparkling' ? ['aperitif', 'fried', 'fresh_cheese', 'fish'] : ['fish', 'fresh_cheese', 'vegetable', 'poultry'];
    return { grapes, color, sweetness, body, acidity, tannin, sparkle: color === 'sparkling' ? 1 : 0, notes, foods, confidence: grapes.length || /(?:vin|wine|вино)/u.test(text) ? 'inferred_from_source' : 'needs_review' };
}

function extractWineCard(sourceText, sourceUrl = null) {
    const raw = clean(sourceText).slice(0, MAX_SOURCE_CHARS);
    if (!raw) throw Object.assign(new Error('WINE_SOURCE_EMPTY'), { code: 'WINE_SOURCE_EMPTY' });
    const title = between(sourceText, [/<title[^>]*>([\s\S]*?)<\/title>/iu]);
    const h1 = between(sourceText, [/<h1[^>]*>([\s\S]*?)<\/h1>/iu]);
    const all = clean(`${title || ''} ${h1 || ''} ${sourceText.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/giu, ' ')}`) || raw;
    const name = clean(h1) || between(all, [/(?:wine|vin|вино)\s*[:\-]\s*([^|.]{3,120})/iu]) || clean(title).replace(/\s*[|–-].*$/, '') || 'Новое вино';
    const vintage = between(all, [/\b((?:19|20)\d{2})\b/u]);
    const producer = between(all, [/(?:winery|cram[ăa]|producer|винодельня|производитель)\s*[:\-]\s*([^|.]{2,120})/iu]);
    const profile = inferProfile({ name, sourceText: all });
    return { name: name.slice(0, 180), producer: producer ? producer.slice(0, 180) : null, vintage, source_url: sourceUrl, source_text: raw, profile };
}

async function fetchSourceText(url, dependencies = {}) {
    const response = await (dependencies.safeFetchResource || safeFetchResource)({ url, maxBytes: MAX_SOURCE_CHARS });
    const body = response.rawBody || response.body;
    return Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
}

async function createDraft({ url = null, text = null, dependencies = {} }) {
    const sourceText = text ? String(text) : await fetchSourceText(url, dependencies);
    const card = extractWineCard(sourceText, url);
    const pool = dependencies.pool || (db.isEnabled() ? db.getPool() : null);
    if (!pool) throw Object.assign(new Error('WINE_CATALOG_UNAVAILABLE'), { code: 'WINE_CATALOG_UNAVAILABLE' });
    const hash = crypto.createHash('sha256').update(card.source_text).digest('hex');
    const result = await pool.query(`
        INSERT INTO kos_wine_catalog_cards (id, source_url, source_text, source_hash, name, producer, vintage, profile_json, status, last_synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',NOW())
        ON CONFLICT (source_url) DO UPDATE SET source_text=EXCLUDED.source_text, source_hash=EXCLUDED.source_hash, name=EXCLUDED.name, producer=EXCLUDED.producer, vintage=EXCLUDED.vintage, profile_json=EXCLUDED.profile_json, status='draft', updated_at=NOW(), last_synced_at=NOW(), last_sync_error=NULL
        RETURNING *;
    `, [id(), card.source_url, card.source_text, hash, card.name, card.producer, card.vintage, JSON.stringify(card.profile)]);
    return present(result.rows[0]);
}

function present(row) { return row ? { ...row, profile: row.profile_json || row.profile || {} } : null; }

async function listCards({ includeDrafts = true, dependencies = {} } = {}) {
    const pool = dependencies.pool || (db.isEnabled() ? db.getPool() : null);
    if (!pool) return [];
    const { rows } = await pool.query(`SELECT * FROM kos_wine_catalog_cards ${includeDrafts ? '' : "WHERE status = 'published'"} ORDER BY updated_at DESC`);
    return rows.map(present);
}

async function publishCard(idValue, { dependencies = {} } = {}) {
    const pool = dependencies.pool || (db.isEnabled() ? db.getPool() : null);
    if (!pool) throw Object.assign(new Error('WINE_CATALOG_UNAVAILABLE'), { code: 'WINE_CATALOG_UNAVAILABLE' });
    const { rows } = await pool.query("UPDATE kos_wine_catalog_cards SET status='published', published_at=COALESCE(published_at,NOW()), updated_at=NOW() WHERE id=$1 RETURNING *", [idValue]);
    if (!rows[0]) throw Object.assign(new Error('WINE_CARD_NOT_FOUND'), { code: 'WINE_CARD_NOT_FOUND', statusCode: 404 });
    return present(rows[0]);
}

async function publishedProfiles({ dependencies = {} } = {}) {
    return (await listCards({ includeDrafts: false, dependencies })).map((card) => ({ id: card.id, name: card.name, aliases: [card.name], ...card.profile, official_profile: { vintage: card.vintage || null, producer: card.producer || null }, profile_source: card.source_url || 'uploaded_technical_sheet' }));
}

async function syncPublishedCards({ dependencies = {} } = {}) {
    const pool = dependencies.pool || (db.isEnabled() ? db.getPool() : null);
    if (!pool) return { checked: 0, updated: 0, failed: 0 };
    const { rows } = await pool.query("SELECT * FROM kos_wine_catalog_cards WHERE status = 'published' AND source_url IS NOT NULL");
    let updated = 0; let failed = 0;
    for (const row of rows) {
        try {
            const sourceText = await fetchSourceText(row.source_url, dependencies);
            const card = extractWineCard(sourceText, row.source_url);
            const hash = crypto.createHash('sha256').update(card.source_text).digest('hex');
            if (hash !== row.source_hash) {
                await pool.query(`UPDATE kos_wine_catalog_cards SET source_text=$1, source_hash=$2, name=$3, producer=$4, vintage=$5, profile_json=$6, last_synced_at=NOW(), last_sync_error=NULL, updated_at=NOW() WHERE id=$7`, [card.source_text, hash, card.name, card.producer, card.vintage, JSON.stringify(card.profile), row.id]);
                updated += 1;
            } else await pool.query('UPDATE kos_wine_catalog_cards SET last_synced_at=NOW(), last_sync_error=NULL WHERE id=$1', [row.id]);
        } catch (error) { failed += 1; await pool.query('UPDATE kos_wine_catalog_cards SET last_sync_error=$1, last_synced_at=NOW() WHERE id=$2', [String(error.message).slice(0, 1000), row.id]); }
    }
    return { checked: rows.length, updated, failed };
}

module.exports = { extractWineCard, createDraft, listCards, publishCard, publishedProfiles, syncPublishedCards };
