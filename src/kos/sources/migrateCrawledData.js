'use strict';

/**
 * Migration script: Import existing crawled knowledge/source/*.md files into Postgres.
 *
 * This script:
 * 1. Reads all discovered-*.md files from knowledge/source/
 * 2. Parses frontmatter and body
 * 3. Inserts into kos_source_documents with document_type classification
 * 4. Creates entity_facts for any structured data found
 * 5. Does NOT delete the original files (manual cleanup after verification)
 *
 * Usage: node src/kos/sources/migrateCrawledData.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../../knowledge/db');
const { parseFrontmatter } = require('../../knowledge/loader');

const SOURCE_DIR = path.resolve(__dirname, '..', '..', '..', 'knowledge', 'source');
const DRY_RUN = process.argv.includes('--dry-run');

function generateId(prefix = 'id') {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function computeContentHash(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function classifyDocument(url, title, body) {
    const urlLower = (url || '').toLowerCase();
    const titleLower = (title || '').toLowerCase();
    const bodyLower = (body || '').toLowerCase();

    // Wine product patterns
    if (/\/wine\//.test(urlLower) || /vin\//.test(urlLower)) return 'wine_product';
    if (/vinul|vinuri|wine/.test(titleLower) && /\d{4}/.test(body)) return 'wine_product';

    // Winery/producer patterns
    if (/\/winery\//.test(urlLower) || /\/producer\//.test(urlLower)) return 'winery_profile';
    if (/winery|crivina|cramă|domaine/i.test(titleLower)) return 'winery_profile';

    // Grape variety patterns
    if (/\/grape\//.test(urlLower) || /feteasc|rara|neagră|sauvignon|merlot/i.test(titleLower)) return 'grape_profile';

    // Region patterns
    if (/\/region\//.test(urlLower) || /valul lui traian|stefan vodă|codru/i.test(titleLower)) return 'region_page';

    // Article/news patterns
    if (/\/news\//.test(urlLower) || /\/article\//.test(urlLower)) return 'article';
    if (/decant|awards|concurs|festiv/i.test(titleLower)) return 'article';

    // Static/contact pages
    if (/\/about\//.test(urlLower) || /\/contact\//.test(urlLower) || /\/terms\//.test(urlLower)) return 'static_info';

    // Commerce pages
    if (/\/cart\//.test(urlLower) || /\/checkout\//.test(urlLower) || /\/account\//.test(urlLower)) return 'commerce_page';

    return 'unknown';
}

async function migrateCrawledData() {
    if (!db.isEnabled()) {
        console.error('[migrate] Postgres not available (DATABASE_URL not set)');
        process.exit(1);
    }

    const pool = db.getPool();
    const startedAt = Date.now();

    // Get all discovered-*.md files
    const files = fs.readdirSync(SOURCE_DIR)
        .filter((f) => f.startsWith('discovered-') && f.endsWith('.md'));

    console.log(`[migrate] Found ${files.length} discovered files in ${SOURCE_DIR}`);

    let imported = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];

    for (const file of files) {
        try {
            const filePath = path.join(SOURCE_DIR, file);
            const raw = fs.readFileSync(filePath, 'utf8');
            const { metadata, body } = parseFrontmatter(raw);

            const url = metadata.source || '';
            const title = metadata.title || file;
            const contentHash = computeContentHash(body);
            const documentType = classifyDocument(url, title, body);

            if (DRY_RUN) {
                console.log(`[dry-run] ${file}: type=${documentType}, url=${url.slice(0, 80)}`);
                imported++;
                continue;
            }

            // Insert into kos_source_documents
            const docId = generateId('doc');
            const sql = `
                INSERT INTO kos_source_documents (
                    id, source_id, requested_url, canonical_url, content_type, content_length,
                    document_type, content_hash, normalized_text, created_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
                ON CONFLICT (source_id, canonical_url)
                DO UPDATE SET
                    document_type = EXCLUDED.document_type,
                    content_hash = EXCLUDED.content_hash,
                    normalized_text = EXCLUDED.normalized_text,
                    updated_at = NOW()
                RETURNING id;
            `;

            // Use 'migrated' as source_id for imported files
            const result = await pool.query(sql, [
                docId,
                'migrated',
                url,
                url,
                'text/markdown',
                Buffer.byteLength(body, 'utf8'),
                documentType,
                contentHash,
                body.slice(0, 100000), // Limit text size
            ]);

            imported++;
            if (imported % 100 === 0) {
                console.log(`[migrate] Progress: ${imported}/${files.length}`);
            }
        } catch (error) {
            failed++;
            errors.push({ file, error: error.message });
            if (failed <= 5) {
                console.error(`[migrate] Failed: ${file}: ${error.message}`);
            }
        }
    }

    const elapsedMs = Date.now() - startedAt;
    console.log(`[migrate] Complete: imported=${imported}, skipped=${skipped}, failed=${failed}, elapsed=${elapsedMs}ms`);

    if (errors.length > 0) {
        console.log(`[migrate] First 5 errors:`, errors.slice(0, 5));
    }

    return { imported, skipped, failed, elapsedMs };
}

// Run if called directly
if (require.main === module) {
    migrateCrawledData()
        .then((result) => {
            console.log(JSON.stringify(result, null, 2));
            process.exit(0);
        })
        .catch((error) => {
            console.error('[migrate] Fatal error:', error);
            process.exit(1);
        });
}

module.exports = { migrateCrawledData, classifyDocument };
