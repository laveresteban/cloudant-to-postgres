import { readFile } from 'node:fs/promises';

export interface SchemaClient {
  query(text: string): Promise<unknown>;
  release(): void;
}

/** schema.sql ships beside the compiled code (dist/src -> ../../schema.sql). */
export function readSchema(): Promise<string> {
  return readFile(new URL('../../schema.sql', import.meta.url), 'utf8');
}

/** Applies the schema at startup. Every statement is IF NOT EXISTS, so this is safe on every boot. */
export async function ensureSchema(connect: () => Promise<SchemaClient>): Promise<void> {
  const sql = await readSchema();
  const client = await connect();
  try {
    await client.query(sql);
  } finally {
    client.release();
  }
}
