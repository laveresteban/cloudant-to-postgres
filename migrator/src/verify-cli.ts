import { Pool } from 'pg';
import { parseConfig } from './config.js';
import { createCouchClient } from './source.js';
import { verifyMigration, type TargetRow } from './verify.js';

const config = parseConfig(process.env);
const couch = createCouchClient({
  baseUrl: config.couchUrl,
  db: config.couchDb,
  username: config.couchUser,
  password: config.couchPassword,
});
const pool = new Pool({ connectionString: config.databaseUrl });
const sampleSize = Number(process.env.SAMPLE_SIZE ?? 200);

interface AllDocsRow {
  id: string;
  doc?: { _id: string; _rev: string; _deleted?: boolean; [k: string]: unknown };
}

const designDocCount = async () =>
  (
    await couch.request<{ rows: unknown[] }>({
      path: '/_all_docs',
      query: { startkey: JSON.stringify('_design/'), endkey: JSON.stringify('_design0') },
    })
  ).rows.length;

try {
  const report = await verifyMigration({
    sampleSize,
    countSource: async () => {
      const { total_rows } = await couch.request<{ total_rows: number }>({
        path: '/_all_docs',
        query: { limit: '0' },
      });
      return total_rows - (await designDocCount());
    },
    countTarget: async () => {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM docs WHERE NOT deleted');
      return rows[0].n as number;
    },
    sampleSource: async (size) => {
      const { total_rows } = await couch.request<{ total_rows: number }>({
        path: '/_all_docs',
        query: { limit: '0' },
      });
      const skip = Math.floor(Math.random() * Math.max(1, total_rows - size));
      const { rows } = await couch.request<{ rows: AllDocsRow[] }>({
        path: '/_all_docs',
        query: { include_docs: 'true', skip: String(skip), limit: String(size + 10) },
      });
      return rows
        .filter((r) => r.doc && !r.id.startsWith('_design/'))
        .slice(0, size)
        .map((r) => {
          const { _id, _rev, _deleted, ...body } = r.doc!;
          return { id: _id, rev: _rev, body };
        });
    },
    targetRow: async (id) => {
      const { rows } = await pool.query<TargetRow>(
        'SELECT rev, body, deleted FROM docs WHERE id = $1',
        [id],
      );
      return rows[0] ?? null;
    },
  });

  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
} finally {
  await pool.end();
}
