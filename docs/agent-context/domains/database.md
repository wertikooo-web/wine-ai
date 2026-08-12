# Database

Treat schema and migration code as the source of truth. Keep runtime settings, session data, knowledge documents, chunks, embeddings, KOS entities, and analytics responsibilities explicit.

Treat irreversible production-data loss and destructive migrations without a
tested rollback as escalation conditions under `../AGENT_WORKFLOW.md`. Verify
migrations against an isolated database, preserve backward compatibility where
required, and confirm application callers use the migrated schema.
