-- Schema owned by the migrator. The migrator applies it on every start (all
-- statements are IF NOT EXISTS), and docker-compose also mounts it for first boot.
--
-- Landing zone: every source document lands here as JSONB, so nothing is lost
-- before the relational model is designed.

CREATE TABLE IF NOT EXISTS docs (
  id         TEXT PRIMARY KEY,
  rev        TEXT NOT NULL,
  body       JSONB NOT NULL,
  deleted    BOOLEAN NOT NULL DEFAULT false,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Containment queries (body @> '{"status":"shipped"}') and general JSON lookups.
CREATE INDEX IF NOT EXISTS docs_body_gin ON docs USING GIN (body jsonb_path_ops);

-- Speeds up the per-type views in normalize.sql.
CREATE INDEX IF NOT EXISTS docs_type_idx ON docs ((body->>'type'));

-- Transactional outbox: one row per changed document, written in the same
-- transaction as the docs row and the checkpoint. Consumers (the alerts service,
-- the app) read it by event_id. event_id is only a safe cursor because a single
-- migrator commits batches one after another; see CLAUDE.md.
CREATE TABLE IF NOT EXISTS change_events (
  event_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id      TEXT NOT NULL,
  rev         TEXT NOT NULL,
  op          TEXT NOT NULL CHECK (op IN ('create', 'update', 'delete')),
  body        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per source database. last_seq is opaque text, as CouchDB/Cloudant defines it.
CREATE TABLE IF NOT EXISTS checkpoints (
  source_db   TEXT PRIMARY KEY,
  last_seq    TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
