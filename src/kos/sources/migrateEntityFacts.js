'use strict';

/**
 * Migration script: Import entity facts from knowledge/entity-facts/*.json into Postgres.
 *
 * This script:
 * 1. Reads wine-md.json (and any other entity fact files)
 * 2. Inserts each fact into entity_facts table
 * 3. Creates provenance records in entity_facts_provenance
 * 4. Does NOT delete the original files (manual cleanup after verification)
 *
 * Usage: node src/kos/sources/migrateEntityFacts.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../../knowledge/db');

const ENTITY_FACTS_DIR = path.resolve(__dirname, '..', '..', '..', 'knowledge', 'entity-facts');
const DRY_RUN = process.argv.includes('--dry-run');

function generateId(prefix = 'id') {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function mapValidationStatus(status) {
    const mapping = {
        discovered: 'discovered',
        candidate: 'candidate',
        validated: 'validated',
        approved: 'approved',
        rejected: 'rejected',
    };
    return mapping[status] || 'discovered';
}

function mapConfidence(confidence) {
    if (confidence === 'high') return 'high';
    if (confidence === 'medium') return 'medium';
    return 'low';
}

async function migrateEntityFacts() {
    if (!db.isEnabled()) {
        console.error('[migrateEntityFacts] Postgres not available (DATABASE_URL not set)');
        process.exit(1);
    }

    const pool = db.getPool();
    const startedAt = Date.now();

    // Get all JSON files in entity-facts directory
    const files = fs.readdirSync(ENTITY_FACTS_DIR)
        .filter((f) => f.endsWith('.json'));

    console.log(`[migrateEntityFacts] Found ${files.length} entity fact files in ${ENTITY_FACTS_DIR}`);

    let imported = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];

    for (const file of files) {
        try {
            const filePath = path.join(ENTITY_FACTS_DIR, file);
            const rawData = JSON.parse(fs.readFileSync(filePath, 'utf8'));

            // Process each field type (address, city, country, etc.)
            for (const [fieldName, facts] of Object.entries(rawData)) {
                if (!Array.isArray(facts)) continue;

                for (const fact of facts) {
                    if (DRY_RUN) {
                        console.log(`[dry-run] ${file}: ${fieldName}=${fact.value}`);
                        imported++;
                        continue;
                    }

                    const factId = generateId('fact');
                    const entityId = fact.entity_id || file.replace('.json', '');

                    // Insert into entity_facts
                    const sql = `
                        INSERT INTO entity_facts (
                            id, entity_id, entity_type, field_name, normalized_value, raw_value,
                            confidence, validation_status, active, source_url, source_type,
                            source_domain, evidence, extraction_method, extractor_version,
                            conflict_state, fetched_at, verified_at, expires_at, created_at, updated_at
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW(), NOW())
                        ON CONFLICT (entity_id, field_name, source_url)
                        DO UPDATE SET
                            normalized_value = EXCLUDED.normalized_value,
                            confidence = EXCLUDED.confidence,
                            validation_status = EXCLUDED.validation_status,
                            active = EXCLUDED.active,
                            updated_at = NOW()
                        RETURNING id;
                    `;

                    let sourceDomain = null;
                    if (fact.source_url) {
                        try {
                            sourceDomain = new URL(fact.source_url).hostname;
                        } catch {}
                    }

                    const result = await pool.query(sql, [
                        factId,
                        entityId,
                        fact.entity_type || 'unknown',
                        fieldName,
                        fact.value,
                        fact.raw_evidence || fact.value,
                        mapConfidence(fact.confidence),
                        mapValidationStatus(fact.validation_status),
                        fact.active === true,
                        fact.source_url,
                        fact.source_type || 'general_web',
                        sourceDomain,
                        fact.raw_evidence,
                        fact.extraction_method || 'unknown',
                        fact.extractor_version || 'v1',
                        fact.validation_status === 'approved' ? 'none' : 'detected',
                        fact.fetched_at || new Date().toISOString(),
                        fact.verified_at,
                        fact.expires_at,
                    ]);

                    const storedFactId = result.rows && result.rows.length > 0 ? result.rows[0].id : factId;

                    // Create provenance record
                    const provId = generateId('prov');
                    const provSql = `
                        INSERT INTO entity_facts_provenance (
                            id, fact_id, source_url, source_type, source_domain,
                            evidence, extraction_method, extractor_version,
                            fetched_at, verified_at, created_at
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
                    `;
                    await pool.query(provSql, [
                        provId,
                        storedFactId,
                        fact.source_url,
                        fact.source_type || 'general_web',
                        sourceDomain,
                        fact.raw_evidence,
                        fact.extraction_method || 'unknown',
                        fact.extractor_version || 'v1',
                        fact.fetched_at || new Date().toISOString(),
                        fact.verified_at,
                    ]);

                    imported++;
                }
            }
        } catch (error) {
            failed++;
            errors.push({ file, error: error.message });
            if (failed <= 5) {
                console.error(`[migrateEntityFacts] Failed: ${file}: ${error.message}`);
            }
        }
    }

    const elapsedMs = Date.now() - startedAt;
    console.log(`[migrateEntityFacts] Complete: imported=${imported}, skipped=${skipped}, failed=${failed}, elapsed=${elapsedMs}ms`);

    if (errors.length > 0) {
        console.log(`[migrateEntityFacts] First 5 errors:`, errors.slice(0, 5));
    }

    return { imported, skipped, failed, elapsedMs };
}

// Run if called directly
if (require.main === module) {
    migrateEntityFacts()
        .then((result) => {
            console.log(JSON.stringify(result, null, 2));
            process.exit(0);
        })
        .catch((error) => {
            console.error('[migrateEntityFacts] Fatal error:', error);
            process.exit(1);
        });
}

module.exports = { migrateEntityFacts };
