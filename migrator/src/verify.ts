import { createHash } from 'node:crypto';

/** JSON with keys sorted at every level, so Postgres jsonb key order does not matter. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fingerprint(body: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalize(body)).digest('hex');
}

export interface SourceDoc {
  id: string;
  rev: string;
  body: Record<string, unknown>;
}

export interface TargetRow {
  rev: string;
  body: Record<string, unknown>;
  deleted: boolean;
}

export interface VerifyDeps {
  countSource(): Promise<number>;
  countTarget(): Promise<number>;
  sampleSource(size: number): Promise<SourceDoc[]>;
  targetRow(id: string): Promise<TargetRow | null>;
  sampleSize: number;
}

export interface VerifyReport {
  ok: boolean;
  sourceDocs: number;
  targetDocs: number;
  sampled: number;
  mismatches: { id: string; reason: 'missing' | 'rev' | 'body' }[];
}

/**
 * Cutover gate. Compares live-doc counts and a random sample of bodies.
 * Run it after the sync reports caughtUp and writes to the source are frozen,
 * otherwise a document edited mid-check shows up as a mismatch.
 */
export async function verifyMigration(deps: VerifyDeps): Promise<VerifyReport> {
  const [sourceDocs, targetDocs, sample] = await Promise.all([
    deps.countSource(),
    deps.countTarget(),
    deps.sampleSource(deps.sampleSize),
  ]);

  const mismatches: VerifyReport['mismatches'] = [];
  for (const doc of sample) {
    const row = await deps.targetRow(doc.id);
    if (!row || row.deleted) {
      mismatches.push({ id: doc.id, reason: 'missing' });
    } else if (row.rev !== doc.rev) {
      mismatches.push({ id: doc.id, reason: 'rev' });
    } else if (fingerprint(row.body) !== fingerprint(doc.body)) {
      mismatches.push({ id: doc.id, reason: 'body' });
    }
  }

  return {
    ok: sourceDocs === targetDocs && mismatches.length === 0,
    sourceDocs,
    targetDocs,
    sampled: sample.length,
    mismatches,
  };
}
