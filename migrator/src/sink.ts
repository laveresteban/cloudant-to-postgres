import type { DocRow } from './mapping.js';
import type { Sink } from './sync.js';

export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface SinkOptions {
  connect: () => Promise<SqlClient>;
  sourceDb: string;
}

// Unnest arrays so a whole batch is one statement. Tombstones keep their id and rev.
// A row whose rev is unchanged (a redelivered change) is skipped: no rewrite, no event.
// Only rows that actually changed come back from RETURNING, and each one becomes an event.
// xmax = 0 is true for a fresh insert and false for an update, which gives create vs update.
const UPSERT_DOCS = `
  WITH upserted AS (
    INSERT INTO docs (id, rev, body, deleted, synced_at)
    SELECT t.id, t.rev, t.body, t.deleted, now()
    FROM unnest($1::text[], $2::text[], $3::jsonb[], $4::boolean[]) AS t(id, rev, body, deleted)
    ON CONFLICT (id) DO UPDATE SET
      rev = EXCLUDED.rev,
      body = EXCLUDED.body,
      deleted = EXCLUDED.deleted,
      synced_at = EXCLUDED.synced_at
    WHERE docs.rev IS DISTINCT FROM EXCLUDED.rev
    RETURNING id, rev, body, deleted, (xmax = 0) AS inserted
  )
  INSERT INTO change_events (doc_id, rev, op, body)
  SELECT id, rev,
         CASE WHEN deleted THEN 'delete' WHEN inserted THEN 'create' ELSE 'update' END,
         body
  FROM upserted`;

const SAVE_CHECKPOINT = `
  INSERT INTO checkpoints (source_db, last_seq, updated_at)
  VALUES ($1, $2, now())
  ON CONFLICT (source_db) DO UPDATE SET
    last_seq = EXCLUDED.last_seq,
    updated_at = EXCLUDED.updated_at`;

/**
 * Postgres implementation of Sink. Rows and checkpoint commit together, so a
 * crash between them cannot skip or double-apply a batch. Replays are safe
 * because each write is an upsert keyed by id.
 */
export function createPostgresSink({ connect, sourceDb }: SinkOptions): Sink {
  return {
    async checkpoint() {
      const client = await connect();
      try {
        const { rows } = await client.query(
          'SELECT last_seq FROM checkpoints WHERE source_db = $1',
          [sourceDb],
        );
        return (rows[0]?.last_seq as string | undefined) ?? '0';
      } finally {
        client.release();
      }
    },

    async apply(rows: DocRow[], lastSeq: string) {
      const client = await connect();
      try {
        await client.query('BEGIN');
        if (rows.length > 0) {
          await client.query(UPSERT_DOCS, [
            rows.map((r) => r.id),
            rows.map((r) => r.rev),
            rows.map((r) => JSON.stringify(r.body)),
            rows.map((r) => r.deleted),
          ]);
        }
        await client.query(SAVE_CHECKPOINT, [sourceDb, lastSeq]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
