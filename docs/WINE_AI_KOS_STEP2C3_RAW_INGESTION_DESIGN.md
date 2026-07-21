# WINE AI KOS — Step 2C.3 Raw Ingestion Vertical Slice Specification

## Overview & Architecture

Step 2C.3 completes the end-to-end raw website ingestion pipeline of KOS by integrating all foundational components into a single, cohesive vertical slice:

```text
SourceRegistry (getSource)
↓
CrawlRun (kos_crawl_runs: 'crawling')
↓
WebsiteCrawlerProvider (crawlWebsite)
↓
For each fetched resource:
  ├── SourceDocument Upsert (kos_source_documents: ON CONFLICT DO UPDATE)
  └── RawResourceStorage (saveRawDocumentVersion)
        ├── SHA-256 Checksum Duplicate -> Item status 'unchanged'
        └── New SHA-256 Checksum       -> Item status 'stored' (ObjectStorage + DB version)
↓
Finalize CrawlRun counters & status ('completed' | 'partial' | 'failed')
```

---

## 1. Database Schema Extensions (Migration v3)

Migration `v3_crawl_items_enrichment_and_constraints` adds enriched tracking fields and strict integrity constraints:

```sql
-- 1. Add enriched tracking columns to kos_crawl_run_items
ALTER TABLE kos_crawl_run_items
    ADD COLUMN IF NOT EXISTS depth INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS parent_url TEXT,
    ADD COLUMN IF NOT EXISTS discovery_source TEXT,
    ADD COLUMN IF NOT EXISTS document_id TEXT REFERENCES kos_source_documents(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS version_id TEXT REFERENCES kos_source_document_versions(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS error_code TEXT,
    ADD COLUMN IF NOT EXISTS error_details JSONB;

-- 2. Update status CHECK constraint on kos_crawl_run_items
ALTER TABLE kos_crawl_run_items DROP CONSTRAINT IF EXISTS kos_crawl_run_items_status_check;
ALTER TABLE kos_crawl_run_items ADD CONSTRAINT kos_crawl_run_items_status_check
    CHECK (status IN ('queued', 'fetching', 'fetched', 'stored', 'unchanged', 'failed', 'skipped'));

-- 3. Add UNIQUE constraint UNIQUE(crawl_run_id, canonical_url)
ALTER TABLE kos_crawl_run_items DROP CONSTRAINT IF EXISTS uk_crawl_item_url;
ALTER TABLE kos_crawl_run_items ADD CONSTRAINT uk_crawl_item_url
    UNIQUE (crawl_run_id, canonical_url);

-- 4. Add CHECK constraints for non-negative counters and sizes
ALTER TABLE kos_crawl_run_items ADD CONSTRAINT chk_crawl_items_attempt_count CHECK (attempt_count >= 0);
ALTER TABLE kos_crawl_runs ADD CONSTRAINT chk_crawl_runs_discovered CHECK (pages_discovered >= 0);
ALTER TABLE kos_crawl_runs ADD CONSTRAINT chk_crawl_runs_fetched CHECK (pages_fetched >= 0);
ALTER TABLE kos_crawl_runs ADD CONSTRAINT chk_crawl_runs_failed CHECK (pages_failed >= 0);
ALTER TABLE kos_source_document_versions ADD CONSTRAINT chk_doc_versions_size CHECK (size_bytes >= 0);
```

---

## 2. Concurrency-Safe SourceDocument Upsert SQL

To guarantee safe concurrent ingestion without duplicate key errors, `SourceDocument` creation uses atomic PostgreSQL upsert:

```sql
INSERT INTO kos_source_documents (
    id, source_id, requested_url, canonical_url, content_type, content_length, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
ON CONFLICT (source_id, canonical_url)
DO UPDATE SET
    requested_url = EXCLUDED.requested_url,
    content_type = EXCLUDED.content_type,
    content_length = EXCLUDED.content_length,
    updated_at = NOW()
RETURNING id;
```

---

## 3. Raw Version Semantics & Deduplication Flow

1. Raw resource bytes (`rawBody`) are passed as a Node `Buffer`.
2. `saveRawDocumentVersion` computes the SHA-256 checksum.
3. Checks `uk_document_checksum (document_id, checksum_sha256)`:
   - **Existing Checksum**: Skipped blob write and DB version insert. Item status marked `'unchanged'`.
   - **New Checksum**: Saved to ObjectStorage (`raw/{checksum}.bin`) and inserted into `kos_source_document_versions`. Item status marked `'stored'`.
4. If a PostgreSQL transaction rolls back, candidate orphan blobs are retained safely for deferred async cleanup (`reconcileOrphanBlobs`).
5. Sensitive headers (`set-cookie`, `authorization`) are sanitized before persistence.

---

## 4. Idempotency & Run Status Classification

- **Re-ingestion**: Subsequent runs of the same website do NOT duplicate `SourceDocument` entries or `SourceDocumentVersion` records for unchanged content. A new `CrawlRun` is created and items receive `'unchanged'` status.
- **Run Status Rules**:
  - All pages succeeded/unchanged -> `'completed'`.
  - Child page failure (seed succeeded) -> `'partial'`.
  - Seed URL failure -> `'failed'`.

---

## 5. Strict Boundary Enforcement

- ZERO database writes of `CandidateDraft` or `ParsedDocument`.
- NO call to extractors or AI models.
- NO changes to legacy knowledge pipeline, REST routes, or Dashboard UI.
