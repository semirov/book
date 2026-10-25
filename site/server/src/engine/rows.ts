/**
 * The two write helpers every engine table shares, and the `meta` key/value pair.
 *
 * Column names are code-controlled constants, never user input; the allow-list regex is a
 * belt-and-braces guard so a future dynamic caller cannot smuggle SQL through a key.
 */

import type { Db } from '../db/db.ts';

const COLUMN = /^[a-z_]+$/u;

/** Patch one row by a code-controlled column name. */
export function updateRow(
  db: Db,
  table: 'changes' | 'steps' | 'leases' | 'cascades' | 'lane',
  keyColumn: string,
  key: string | number,
  patch: Record<string, string | number | null>,
): number {
  const entries = Object.entries(patch);
  if (entries.length === 0) return 0;
  for (const [column] of entries) {
    if (!COLUMN.test(column)) throw new Error(`refusing column ${column}`);
  }
  const assignments = entries.map(([column]) => `${column} = @${column}`).join(', ');
  const result = db
    .prepare(`UPDATE ${table} SET ${assignments} WHERE ${keyColumn} = @__key`)
    .run({ ...patch, __key: key });
  return result.changes;
}

/** Insert one row from a code-shaped object. */
export function insertRow(
  db: Db,
  table: 'changes' | 'steps' | 'leases' | 'cascades',
  values: Record<string, string | number | null>,
): void {
  const columns = Object.keys(values);
  for (const column of columns) {
    if (!COLUMN.test(column)) throw new Error(`refusing column ${column}`);
  }
  const placeholders = columns.map((column) => `@${column}`).join(', ');
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`).run(values);
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(key) as { v: string } | undefined;
  return row?.v ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(
    key,
    value,
  );
}
