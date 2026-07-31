# Database

Treat schema and migration code as the source of truth. Keep runtime settings, session data, knowledge documents, chunks, embeddings, KOS entities, and analytics responsibilities explicit.

Do not perform production writes or destructive migrations without explicit authorization. Verify migrations against an isolated database, preserve backward compatibility where required, and confirm application callers use the migrated schema.
