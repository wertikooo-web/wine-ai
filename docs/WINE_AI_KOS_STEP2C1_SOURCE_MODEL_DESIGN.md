# WINE AI KOS — Step 2C.1 Source Model Design Specification (Final Approved Specification)

## Overview & Architecture Principles

This document defines the final, locked data model for the KOS Source Layer prior to production code implementation.

### Core Architectural Separation Rules:
1. **Source** is a registered entity with explicit `seed_url` and `normalized_origin`.
2. **Document / CrawledResource** is a canonical URL mapping (`canonical_url`), not raw bytes.
3. **CrawlRunItem** tracks durable per-URL execution status for recovery and retry.
4. **SourceDocumentVersion** is an immutable raw byte snapshot metadata record (raw bytes in ObjectStorage `raw/{sha256}.bin`). Historical raw versions retain `crawl_run_id ON DELETE SET NULL`.
5. **ParsedDocument** is a format adapter output, not a published fact.
6. **CandidateDraft** is an unverified candidate.

---

## 1. Entity Relationship (ER) Diagram

```mermaid
erDiagram
    kos_wineries ||--o{ kos_sources : "optional winery scope"
    kos_sources ||--o{ kos_crawl_runs : "executes crawl runs"
    kos_sources ||--o{ kos_source_documents : "contains canonical resources"
    kos_crawl_runs ||--o{ kos_crawl_run_items : "tracks per-url items"
    kos_crawl_runs ||--o{ kos_source_document_versions : "historical run link (SET NULL)"
    kos_source_documents ||--o{ kos_source_document_versions : "holds raw versions"
    kos_source_document_versions ||--o{ kos_parsed_documents : "parsed by adapters"
    kos_parsed_documents ||--o{ kos_candidate_drafts : "yields candidates"

    kos_sources {
        string id PK
        string name
        string seed_url
        string normalized_origin UK
        string source_type
        string trust_level "default 'C'"
        string publisher
        string winery_id FK "nullable"
        timestamptz created_at
        timestamptz updated_at
    }

    kos_crawl_runs {
        string id PK
        string source_id FK
        string status "queued|crawling|stored|parsing|extracting|completed|partial|failed"
        jsonb config_snapshot
        int pages_discovered
        int pages_fetched
        int pages_failed
        jsonb error_details
        timestamptz started_at
        timestamptz completed_at
    }

    kos_crawl_run_items {
        string id PK
        string crawl_run_id FK
        string url
        string canonical_url
        string status "queued|fetching|fetched|failed"
        int http_status
        string error_message
        int attempt_count
        timestamptz updated_at
    }

    kos_source_documents {
        string id PK
        string source_id FK
        string requested_url
        string canonical_url
        string content_type
        bigint content_length
        timestamptz created_at
        timestamptz updated_at
    }

    kos_source_document_versions {
        string id PK
        string document_id FK
        string crawl_run_id FK "nullable SET NULL"
        string checksum_sha256
        string storage_key
        bigint size_bytes
        string declared_mime_type
        string detected_mime_type
        jsonb http_headers
        timestamptz fetched_at
        timestamptz created_at
    }

    kos_parsed_documents {
        string id PK
        string version_id FK
        string document_id FK
        string adapter_name
        string adapter_version
        string canonical_text
        jsonb structural_units
        jsonb metadata
        timestamptz parsed_at
    }

    kos_candidate_drafts {
        string id PK
        string parsed_document_id FK
        string entity_type
        jsonb entity_ref
        string field_path
        text raw_value
        jsonb normalized_value
        string value_type
        jsonb evidence_drafts
        numeric confidence_score
        string extractor_name
        string extractor_version
        timestamptz extracted_at
    }
```

---

## 2. SQL Schema Definition

```sql
-- 1. Source Registry
CREATE TABLE IF NOT EXISTS kos_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    seed_url TEXT NOT NULL,
    normalized_origin TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL CHECK (source_type IN ('official_website', 'industry_portal', 'government', 'contest', 'media', 'catalog', 'other')),
    trust_level TEXT NOT NULL DEFAULT 'C' CHECK (trust_level IN ('A', 'B', 'C', 'D')),
    publisher TEXT,
    winery_id TEXT REFERENCES kos_wineries(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kos_sources_winery ON kos_sources(winery_id);
CREATE INDEX IF NOT EXISTS idx_kos_sources_origin ON kos_sources(normalized_origin);

-- 2. Crawl Runs Tracker
CREATE TABLE IF NOT EXISTS kos_crawl_runs (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES kos_sources(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'crawling', 'stored', 'parsing', 'extracting', 'completed', 'partial', 'failed')),
    config_snapshot JSONB NOT NULL,
    pages_discovered INT DEFAULT 0,
    pages_fetched INT DEFAULT 0,
    pages_failed INT DEFAULT 0,
    error_details JSONB,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kos_crawl_runs_source ON kos_crawl_runs(source_id);
CREATE INDEX IF NOT EXISTS idx_kos_crawl_runs_status ON kos_crawl_runs(status);

-- 3. Per-URL Crawl Run Items
CREATE TABLE IF NOT EXISTS kos_crawl_run_items (
    id TEXT PRIMARY KEY,
    crawl_run_id TEXT NOT NULL REFERENCES kos_crawl_runs(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'fetching', 'fetched', 'failed')),
    http_status INT,
    error_message TEXT,
    attempt_count INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kos_crawl_items_run ON kos_crawl_run_items(crawl_run_id);
CREATE INDEX IF NOT EXISTS idx_kos_crawl_items_status ON kos_crawl_run_items(status);

-- 4. Crawled Resources (Source Documents)
CREATE TABLE IF NOT EXISTS kos_source_documents (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES kos_sources(id) ON DELETE CASCADE,
    requested_url TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    content_type TEXT,
    content_length BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uk_source_canonical_url UNIQUE (source_id, canonical_url)
);
CREATE INDEX IF NOT EXISTS idx_kos_source_docs_source ON kos_source_documents(source_id);
CREATE INDEX IF NOT EXISTS idx_kos_source_docs_canonical ON kos_source_documents(canonical_url);

-- 5. Immutable Raw Versions (No duplicate source_id, crawl_run_id ON DELETE SET NULL)
CREATE TABLE IF NOT EXISTS kos_source_document_versions (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES kos_source_documents(id) ON DELETE CASCADE,
    crawl_run_id TEXT REFERENCES kos_crawl_runs(id) ON DELETE SET NULL,
    checksum_sha256 TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    declared_mime_type TEXT NOT NULL,
    detected_mime_type TEXT NOT NULL,
    http_headers JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uk_document_checksum UNIQUE (document_id, checksum_sha256)
);
CREATE INDEX IF NOT EXISTS idx_kos_doc_versions_document ON kos_source_document_versions(document_id);
CREATE INDEX IF NOT EXISTS idx_kos_doc_versions_checksum ON kos_source_document_versions(checksum_sha256);
CREATE INDEX IF NOT EXISTS idx_kos_doc_versions_crawl_run ON kos_source_document_versions(crawl_run_id);

-- 6. Parsed Documents
CREATE TABLE IF NOT EXISTS kos_parsed_documents (
    id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES kos_source_document_versions(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES kos_source_documents(id) ON DELETE CASCADE,
    adapter_name TEXT NOT NULL,
    adapter_version TEXT NOT NULL,
    canonical_text TEXT NOT NULL,
    structural_units JSONB NOT NULL,
    metadata JSONB,
    parsed_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uk_version_adapter UNIQUE (version_id, adapter_name, adapter_version)
);
CREATE INDEX IF NOT EXISTS idx_kos_parsed_docs_version ON kos_parsed_documents(version_id);

-- 7. Candidate Drafts
CREATE TABLE IF NOT EXISTS kos_candidate_drafts (
    id TEXT PRIMARY KEY,
    parsed_document_id TEXT NOT NULL REFERENCES kos_parsed_documents(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    entity_ref JSONB NOT NULL,
    field_path TEXT NOT NULL,
    raw_value TEXT NOT NULL,
    normalized_value JSONB,
    value_type TEXT NOT NULL,
    evidence_drafts JSONB NOT NULL,
    confidence_score NUMERIC(3,2) NOT NULL,
    extractor_name TEXT NOT NULL,
    extractor_version TEXT NOT NULL,
    extracted_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kos_drafts_parsed_doc ON kos_candidate_drafts(parsed_document_id);
```

---

## 3. Storage Strategy & Atomic Protocol

1. Stream raw bytes into memory/buffer.
2. Compute SHA-256 hash.
3. Check `uk_document_checksum` in PostgreSQL. If exists, skip Object Storage write and reuse existing version.
4. If new, save bytes to Object Storage key `raw/{sha256}.bin`.
5. Execute PostgreSQL transaction inserting version metadata into `kos_source_document_versions`.
6. Deferred Async Reconciliation: Unreferenced content-addressed blobs are cleaned up asynchronously via `reconcileOrphanBlobs({ gracePeriodMs })` after confirming zero DB references remain.

---

## 4. SSRF Threat Model & Socket Pinning

1. URLs containing `@` (embedded credentials) are rejected immediately.
2. Schemes are strictly `http:` or `https:`; ports restricted to `80` and `443`.
3. Perform DNS resolution (`dns.resolve4` / `dns.resolve6`). Verify resolved IPs against CIDRs. Connect directly to the validated IP address to prevent TOCTOU DNS rebinding (implemented in Step 2C.2 Safe HTTP Client).

---

## 5. Implementation Roadmap (Phased Approach)

### Phase 1: Step 2C.1 — Schema, Migrations & Contracts (Current Baseline Scope)
- Migration `v2_sources_and_raw_ingestion_schema` in `kosSchema.js` with real migration checksums and `KOS_SCHEMA_DRIFT_DETECTED` validation.
- `ssrfProtection.js` (SSRF verification & URL syntactic normalization).
- `sourceRegistry.js` (Source CRUD with `seed_url` & `normalized_origin`).
- `rawResourceStorage.js` (ObjectStorage raw bytes + DB metadata with async orphan reconciliation).
- Mandatory real PostgreSQL integration test suite `tests/kosSchema.postgres.integration.test.js`.

---

## 10. Recorded Non-Blocking Follow-Ups (ADR Backlog)

- **`FOLLOW-UP 2C1-1`**: Add `CONSTRAINT uk_crawl_item_url UNIQUE (crawl_run_id, canonical_url)` for per-URL crawl items in `kos_crawl_run_items`.
- **`FOLLOW-UP 2C1-2`**: Add PostgreSQL CHECK constraints for non-negative counters (`pages_discovered >= 0`, `pages_fetched >= 0`, `pages_failed >= 0`), `attempt_count >= 0`, and `size_bytes >= 0`.
- **`FOLLOW-UP 2C1-3`**: Support explicit item/version status `unchanged` for re-fetched resources yielding identical SHA-256 checksums.
- **`FOLLOW-UP 2C1-4`**: Transition from hard delete on `kos_sources` to soft-delete / `status = 'archived'` prior to production delete API launch.
