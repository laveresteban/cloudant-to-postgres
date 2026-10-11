import type { Alert } from './rules.js';

export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface StoredAlert {
  event_id: number;
  rule: string;
  doc_id: string;
  message: string;
  created_at: string;
}

const CONSUMER = 'alerts';

/**
 * Owns the `alerts` schema. The schema is created on startup, so the service does
 * not depend on the migrator's schema.sql. Alerts are idempotent: (event_id, rule) is
 * the primary key, so a replayed event cannot produce a second alert.
 */
export function createAlertStore({ connect }: { connect: () => Promise<SqlClient> }) {
  return {
    async migrate(): Promise<void> {
      const client = await connect();
      try {
        await client.query('CREATE SCHEMA IF NOT EXISTS alerts');
        await client.query(`
          CREATE TABLE IF NOT EXISTS alerts.alerts (
            event_id    BIGINT NOT NULL,
            rule        TEXT NOT NULL,
            doc_id      TEXT NOT NULL,
            message     TEXT NOT NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (event_id, rule)
          )`);
        await client.query(`
          CREATE TABLE IF NOT EXISTS alerts.cursors (
            consumer       TEXT PRIMARY KEY,
            last_event_id  BIGINT NOT NULL
          )`);
      } finally {
        client.release();
      }
    },

    async cursor(): Promise<number> {
      const client = await connect();
      try {
        const { rows } = await client.query(
          'SELECT last_event_id FROM alerts.cursors WHERE consumer = $1',
          [CONSUMER],
        );
        // BIGINT comes back as a string. Convert it before it is used as a cursor.
        return rows[0] ? Number(rows[0].last_event_id) : 0;
      } finally {
        client.release();
      }
    },

    /** Alerts and the cursor commit together, so a crash replays the batch instead of skipping it. */
    async save(alerts: Alert[], next: number): Promise<void> {
      const client = await connect();
      try {
        await client.query('BEGIN');
        for (const a of alerts) {
          await client.query(
            `INSERT INTO alerts.alerts (event_id, rule, doc_id, message)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (event_id, rule) DO NOTHING`,
            [a.event_id, a.rule, a.doc_id, a.message],
          );
        }
        await client.query(
          `INSERT INTO alerts.cursors (consumer, last_event_id) VALUES ($1, $2)
           ON CONFLICT (consumer) DO UPDATE SET last_event_id = EXCLUDED.last_event_id`,
          [CONSUMER, next],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async list(limit: number): Promise<StoredAlert[]> {
      const client = await connect();
      try {
        const { rows } = await client.query(
          `SELECT event_id, rule, doc_id, message, created_at
           FROM alerts.alerts ORDER BY event_id DESC, rule LIMIT $1`,
          [limit],
        );
        return rows.map((r) => ({
          event_id: Number(r.event_id),
          rule: r.rule as string,
          doc_id: r.doc_id as string,
          message: r.message as string,
          created_at: (r.created_at as Date).toISOString(),
        }));
      } finally {
        client.release();
      }
    },
  };
}

export type AlertStore = ReturnType<typeof createAlertStore>;
