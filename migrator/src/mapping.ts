/** One entry from CouchDB/Cloudant `_changes` (requires include_docs=true). */
export interface ChangeRow {
  id: string;
  seq: string;
  changes: { rev: string }[];
  deleted?: boolean;
  doc?: { _id: string; _rev: string; _deleted?: boolean; [field: string]: unknown };
}

/** The row written to the Postgres landing table `docs`. */
export interface DocRow {
  id: string;
  rev: string;
  body: Record<string, unknown>;
  deleted: boolean;
}

/**
 * Maps one change to a landing-table row. Returns null for design docs, which
 * are view definitions rather than data. Deleted docs become tombstones
 * (deleted = true, empty body) so the delete is replicated, not lost.
 */
export function toDocRow(change: ChangeRow): DocRow | null {
  if (change.id.startsWith('_design/')) return null;
  if (!change.doc) {
    throw new Error(`change ${change.id} has no doc; use include_docs=true`);
  }
  const { _id, _rev, _deleted, ...body } = change.doc;
  const deleted = _deleted === true || change.deleted === true;
  return {
    id: change.id,
    rev: _rev ?? change.changes[0].rev,
    body: deleted ? {} : body,
    deleted,
  };
}

/** Keeps one row per id (the last one seen), so a batch never upserts an id twice. */
export function dedupeLast(rows: DocRow[]): DocRow[] {
  const byId = new Map<string, DocRow>();
  for (const row of rows) {
    byId.delete(row.id);
    byId.set(row.id, row);
  }
  return [...byId.values()];
}
