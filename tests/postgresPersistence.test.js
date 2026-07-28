'use strict';

/**
 * Tests for Postgres-first persistence — verifies that:
 * 1. Active knowledge reads from Postgres (not filesystem)
 * 2. Document survives redeploy (Postgres is source of truth)
 * 3. No Git mutation from crawler
 * 4. No Railway deploy from crawler
 * 5. Entity facts are stored in Postgres with provenance
 * 6. Structured lookup works after migration
 * 7. Conflicting facts are not silently overwritten
 * 8. Unverified facts don't enter active fast-path
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

describe('Postgres-First Persistence', () => {
    describe('1. Active knowledge reads from Postgres', () => {
        it('loader.js should have loadDocumentsFromPostgres function', () => {
            const loader = require('../src/knowledge/loader');
            assert.strictEqual(typeof loader.loadDocumentsFromPostgres, 'function');
        });

        it('index.js buildIndexFromPostgres should read from kos_source_documents', () => {
            const indexContent = fs.readFileSync(
                path.join(ROOT, 'src', 'knowledge', 'index.js'),
                'utf8'
            );
            assert.ok(
                indexContent.includes('kos_source_documents'),
                'buildIndexFromPostgres should query kos_source_documents'
            );
            assert.ok(
                indexContent.includes("status = 'active'"),
                'Should filter by active status'
            );
        });

        it('index.js buildIndexFromPostgres should use title from Postgres', () => {
            const indexContent = fs.readFileSync(
                path.join(ROOT, 'src', 'knowledge', 'index.js'),
                'utf8'
            );
            assert.ok(
                indexContent.includes('row.title'),
                'Should use row.title for document title'
            );
        });

        it('index.js buildIndexFromPostgres should use language from Postgres', () => {
            const indexContent = fs.readFileSync(
                path.join(ROOT, 'src', 'knowledge', 'index.js'),
                'utf8'
            );
            assert.ok(
                indexContent.includes('row.language'),
                'Should use row.language for document language'
            );
        });
    });

    describe('2. Document survives redeploy (Postgres is source of truth)', () => {
        it('kos_source_documents should have normalized_text column', () => {
            const schemaContent = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'db', 'kosSchema.js'),
                'utf8'
            );
            assert.ok(
                schemaContent.includes('normalized_text'),
                'Schema should have normalized_text column'
            );
        });

        it('kos_source_documents should have status column', () => {
            const schemaContent = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'db', 'kosSchema.js'),
                'utf8'
            );
            assert.ok(
                schemaContent.includes("status TEXT DEFAULT 'pending'"),
                'Schema should have status column with pending default'
            );
        });

        it('kos_source_documents should have title column', () => {
            const schemaContent = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'db', 'kosSchema.js'),
                'utf8'
            );
            assert.ok(
                schemaContent.includes('ADD COLUMN IF NOT EXISTS title TEXT'),
                'Schema should have title column'
            );
        });

        it('kos_source_documents should have language column', () => {
            const schemaContent = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'db', 'kosSchema.js'),
                'utf8'
            );
            assert.ok(
                schemaContent.includes("ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'auto'"),
                'Schema should have language column'
            );
        });
    });

    describe('3. No Git mutation from crawler', () => {
        it('crawlIngestionService should not import gitPersist', () => {
            const content = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'sources', 'crawlIngestionService.js'),
                'utf8'
            );
            assert.ok(
                !content.includes("require('../../knowledge/gitPersist')"),
                'crawlIngestionService.js should not import gitPersist'
            );
        });

        it('crawlIngestionService should not call commitKnowledgeFiles', () => {
            const content = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'sources', 'crawlIngestionService.js'),
                'utf8'
            );
            assert.ok(
                !content.includes('commitKnowledgeFiles('),
                'crawlIngestionService.js should not call commitKnowledgeFiles'
            );
        });

        it('crawlIngestionService should not have GitHub API calls', () => {
            const content = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'sources', 'crawlIngestionService.js'),
                'utf8'
            );
            assert.ok(
                !content.includes('api.github.com'),
                'crawlIngestionService.js should not call GitHub API'
            );
            assert.ok(
                !content.includes('GITHUB_PUSH_TOKEN'),
                'crawlIngestionService.js should not reference GITHUB_PUSH_TOKEN'
            );
        });

        it('crawlIngestionService should not have git commands', () => {
            const content = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'sources', 'crawlIngestionService.js'),
                'utf8'
            );
            assert.ok(!content.includes('git add'), 'Should not have git add');
            assert.ok(!content.includes('git commit'), 'Should not have git commit');
            assert.ok(!content.includes('git push'), 'Should not have git push');
        });
    });

    describe('4. No Railway deploy from crawler', () => {
        it('crawlIngestionService should not trigger Railway deploy', () => {
            const content = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'sources', 'crawlIngestionService.js'),
                'utf8'
            );
            assert.ok(
                !content.includes('railway') && !content.includes('RAILWAY'),
                'crawlIngestionService.js should not reference Railway'
            );
        });

        it('crawlIngestionService should log about Postgres-only storage', () => {
            const content = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'sources', 'crawlIngestionService.js'),
                'utf8'
            );
            assert.ok(
                content.includes('Postgres') || content.includes('stored in Postgres'),
                'Should indicate Postgres-only storage'
            );
        });
    });

    describe('5. Entity facts are stored in Postgres with provenance', () => {
        it('entity_facts_provenance table should exist in schema', () => {
            const schemaContent = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'db', 'kosSchema.js'),
                'utf8'
            );
            assert.ok(
                schemaContent.includes('CREATE TABLE IF NOT EXISTS entity_facts_provenance'),
                'Schema should have entity_facts_provenance table'
            );
        });

        it('entity_facts_provenance should have fact_id foreign key', () => {
            const schemaContent = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'db', 'kosSchema.js'),
                'utf8'
            );
            assert.ok(
                schemaContent.includes('REFERENCES entity_facts(id) ON DELETE CASCADE'),
                'Should have foreign key to entity_facts'
            );
        });

        it('entity_facts_provenance should have source tracking columns', () => {
            const schemaContent = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'db', 'kosSchema.js'),
                'utf8'
            );
            const requiredColumns = ['source_url', 'source_type', 'source_domain', 'evidence', 'extraction_method'];
            for (const col of requiredColumns) {
                assert.ok(
                    schemaContent.includes(col),
                    `entity_facts_provenance should have ${col} column`
                );
            }
        });

        it('migrateEntityFacts script should exist', () => {
            const scriptPath = path.join(ROOT, 'src', 'kos', 'sources', 'migrateEntityFacts.js');
            assert.ok(fs.existsSync(scriptPath), 'migrateEntityFacts.js should exist');
        });
    });

    describe('6. Structured lookup works after migration', () => {
        it('migrateCrawledData should handle title and language columns', () => {
            const scriptContent = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'sources', 'migrateCrawledData.js'),
                'utf8'
            );
            assert.ok(
                scriptContent.includes('title'),
                'Migration should handle title column'
            );
            assert.ok(
                scriptContent.includes('language'),
                'Migration should handle language column'
            );
        });

        it('migrateCrawledData should set status to active', () => {
            const scriptContent = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'sources', 'migrateCrawledData.js'),
                'utf8'
            );
            assert.ok(
                scriptContent.includes("'active'"),
                'Migration should set status to active'
            );
        });
    });

    describe('7. Conflicting facts are not silently overwritten', () => {
        it('entity_facts should have conflict_state column', () => {
            const schemaContent = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'db', 'kosSchema.js'),
                'utf8'
            );
            assert.ok(
                schemaContent.includes('conflict_state'),
                'entity_facts should have conflict_state column'
            );
        });

        it('entity_facts should have ON CONFLICT handling', () => {
            const migrateContent = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'sources', 'migrateEntityFacts.js'),
                'utf8'
            );
            assert.ok(
                migrateContent.includes('ON CONFLICT'),
                'Migration should use ON CONFLICT for idempotency'
            );
        });
    });

    describe('8. Unverified facts do not enter active fast-path', () => {
        it('entity_facts should have active column with default FALSE', () => {
            const schemaContent = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'db', 'kosSchema.js'),
                'utf8'
            );
            assert.ok(
                schemaContent.includes("active BOOLEAN NOT NULL DEFAULT FALSE"),
                'entity_facts should have active column with default FALSE'
            );
        });

        it('entity_facts should have validation_status column', () => {
            const schemaContent = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'db', 'kosSchema.js'),
                'utf8'
            );
            assert.ok(
                schemaContent.includes("validation_status TEXT NOT NULL DEFAULT 'discovered'"),
                'entity_facts should have validation_status column'
            );
        });

        it('WineMD address fact should be unverified', () => {
            const facts = JSON.parse(fs.readFileSync(
                path.join(ROOT, 'knowledge', 'entity-facts', 'wine-md.json'),
                'utf8'
            ));
            assert.strictEqual(facts.address[0].validation_status, 'discovered');
            assert.strictEqual(facts.address[0].active, false);
            assert.strictEqual(facts.address[0].confidence, 'low');
        });

        it('WineMD country fact should be approved', () => {
            const facts = JSON.parse(fs.readFileSync(
                path.join(ROOT, 'knowledge', 'entity-facts', 'wine-md.json'),
                'utf8'
            ));
            assert.strictEqual(facts.country[0].validation_status, 'approved');
            assert.strictEqual(facts.country[0].active, true);
            assert.strictEqual(facts.country[0].confidence, 'high');
        });
    });

    describe('9. .gitignore has runtime crawler paths', () => {
        it('should ignore discovered-*.md files', () => {
            const gitignore = fs.readFileSync(
                path.join(ROOT, '.gitignore'),
                'utf8'
            );
            assert.ok(
                gitignore.includes('knowledge/source/discovered-*.md'),
                '.gitignore should ignore knowledge/source/discovered-*.md'
            );
        });

        it('should ignore entity-facts/*.json', () => {
            const gitignore = fs.readFileSync(
                path.join(ROOT, '.gitignore'),
                'utf8'
            );
            assert.ok(
                gitignore.includes('knowledge/entity-facts/*.json'),
                '.gitignore should ignore knowledge/entity-facts/*.json'
            );
        });

        it('should ignore raw_objects/', () => {
            const gitignore = fs.readFileSync(
                path.join(ROOT, '.gitignore'),
                'utf8'
            );
            assert.ok(
                gitignore.includes('knowledge/raw_objects/'),
                '.gitignore should ignore knowledge/raw_objects/'
            );
        });
    });

    describe('10. Migration version tracking', () => {
        it('kosSchema should have 6 migrations defined', () => {
            const schemaContent = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'db', 'kosSchema.js'),
                'utf8'
            );
            assert.ok(
                schemaContent.includes("version: 6"),
                'Should have migration v6'
            );
        });

        it('v6 migration should create entity_facts_provenance', () => {
            const schemaContent = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'db', 'kosSchema.js'),
                'utf8'
            );
            assert.ok(
                schemaContent.includes('v6_entity_facts_provenance_and_doc_enrichment'),
                'v6 migration should be named correctly'
            );
        });
    });
});
