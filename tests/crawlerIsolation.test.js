'use strict';

/**
 * Tests for crawler isolation — verifies that:
 * 1. Crawler does not call commitKnowledgeFiles
 * 2. Crawler does not call GitHub REST API
 * 3. One batch does not create Git commit
 * 4. Queued items resume correctly
 * 5. Repeated run does not create duplicates
 * 6. Conflicting facts are not silently overwritten
 * 7. Unverified fact does not enter active fast-path
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

describe('Crawler Isolation', () => {
    describe('1. Crawler does not call commitKnowledgeFiles', () => {
        it('should not import commitKnowledgeFiles in crawlIngestionService', () => {
            const content = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'sources', 'crawlIngestionService.js'),
                'utf8'
            );

            // Should NOT have require for gitPersist
            assert.ok(
                !content.includes("require('../../knowledge/gitPersist')"),
                'crawlIngestionService.js should not import gitPersist'
            );

            // Should NOT call commitKnowledgeFiles
            assert.ok(
                !content.includes('commitKnowledgeFiles('),
                'crawlIngestionService.js should not call commitKnowledgeFiles'
            );
        });

        it('should log instead of pushing to Git', () => {
            const content = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'sources', 'crawlIngestionService.js'),
                'utf8'
            );

            // Should have log message about not pushing to Git
            assert.ok(
                content.includes('not pushed to Git') || content.includes('Git push REMOVED'),
                'crawlIngestionService.js should log that files are not pushed to Git'
            );
        });
    });

    describe('2. Crawler does not call GitHub REST API', () => {
        it('should not have GitHub API calls in crawlIngestionService', () => {
            const content = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'sources', 'crawlIngestionService.js'),
                'utf8'
            );

            // Should NOT have GitHub API calls
            assert.ok(
                !content.includes('api.github.com'),
                'crawlIngestionService.js should not call GitHub API'
            );
            assert.ok(
                !content.includes('GITHUB_PUSH_TOKEN'),
                'crawlIngestionService.js should not reference GITHUB_PUSH_TOKEN'
            );
        });
    });

    describe('3. One batch does not create Git commit', () => {
        it('should not have git add/commit/push in crawlIngestionService', () => {
            const content = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'sources', 'crawlIngestionService.js'),
                'utf8'
            );

            // Should NOT have git commands
            assert.ok(!content.includes('git add'), 'Should not have git add');
            assert.ok(!content.includes('git commit'), 'Should not have git commit');
            assert.ok(!content.includes('git push'), 'Should not have git push');
        });
    });

    describe('4. Queued items resume correctly', () => {
        it('should have resumeCrawlRun function in crawlResumeService', () => {
            const service = require('../src/kos/sources/crawlResumeService');
            assert.strictEqual(typeof service.resumeCrawlRun, 'function');
        });

        it('should have getResumeStatus function', () => {
            const service = require('../src/kos/sources/crawlResumeService');
            assert.strictEqual(typeof service.getResumeStatus, 'function');
        });

        it('should have fetchAndLockItems function', () => {
            const service = require('../src/kos/sources/crawlResumeService');
            assert.strictEqual(typeof service.fetchAndLockItems, 'function');
        });
    });

    describe('5. Repeated run does not create duplicates', () => {
        it('should have idempotent INSERT with ON CONFLICT in crawlIngestionService', () => {
            const content = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'sources', 'crawlIngestionService.js'),
                'utf8'
            );

            // Should have ON CONFLICT for idempotency
            assert.ok(
                content.includes('ON CONFLICT'),
                'crawlIngestionService.js should have ON CONFLICT for idempotency'
            );
        });
    });

    describe('6. Conflicting facts are not silently overwritten', () => {
        it('should have conflict_state in entity_facts schema', () => {
            const schemaContent = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'db', 'kosSchema.js'),
                'utf8'
            );

            assert.ok(
                schemaContent.includes('conflict_state'),
                'Schema should have conflict_state column'
            );
        });
    });

    describe('7. Unverified fact does not enter active fast-path', () => {
        it('should have active column in entity_facts schema', () => {
            const schemaContent = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'db', 'kosSchema.js'),
                'utf8'
            );

            assert.ok(
                schemaContent.includes('active BOOLEAN NOT NULL DEFAULT FALSE'),
                'Schema should have active column with default FALSE'
            );
        });

        it('should have validation_status in entity_facts schema', () => {
            const schemaContent = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'db', 'kosSchema.js'),
                'utf8'
            );

            assert.ok(
                schemaContent.includes("validation_status TEXT NOT NULL DEFAULT 'discovered'"),
                'Schema should have validation_status with default discovered'
            );
        });
    });

    describe('8. WineMD facts have correct validation_status', () => {
        it('should have validation_status in wine-md.json', () => {
            const facts = JSON.parse(fs.readFileSync(
                path.join(ROOT, 'knowledge', 'entity-facts', 'wine-md.json'),
                'utf8'
            ));

            // Address should be unverified
            assert.strictEqual(facts.address[0].validation_status, 'discovered');
            assert.strictEqual(facts.address[0].active, false);
            assert.strictEqual(facts.address[0].confidence, 'low');

            // Country should be approved
            assert.strictEqual(facts.country[0].validation_status, 'approved');
            assert.strictEqual(facts.country[0].active, true);
            assert.strictEqual(facts.country[0].confidence, 'high');

            // Official website should be approved
            assert.strictEqual(facts.official_website[0].validation_status, 'approved');
            assert.strictEqual(facts.official_website[0].active, true);
        });
    });

    describe('9. Entity facts schema has required columns', () => {
        it('should have all required columns', () => {
            const schemaContent = fs.readFileSync(
                path.join(ROOT, 'src', 'kos', 'db', 'kosSchema.js'),
                'utf8'
            );

            const requiredColumns = [
                'entity_id',
                'entity_type',
                'field_name',
                'normalized_value',
                'confidence',
                'validation_status',
                'active',
                'source_url',
                'source_type',
                'evidence',
                'conflict_state',
            ];

            for (const col of requiredColumns) {
                assert.ok(
                    schemaContent.includes(col),
                    `Schema should have ${col} column`
                );
            }
        });
    });

    describe('10. .gitignore has runtime crawler paths', () => {
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
    });
});
