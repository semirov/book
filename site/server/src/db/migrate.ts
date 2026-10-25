import { SCHEMA_SQL, SCHEMA_VERSION, REQUIRED_TABLES } from './schema.ts';
import type { Db } from './db.ts';

/**
 * Apply the schema in one transaction, then probe it. `user_version` is the migration
 * cursor; M0 has exactly one step, and later milestones append steps rather than editing
 * this one (the DB may already exist in the field).
 */
export function migrate(db: Db): { from: number; to: number } {
  const from = Number(db.pragma('user_version', { simple: true }) ?? 0);
  if (from >= SCHEMA_VERSION) {
    probe(db);
    return { from, to: from };
  }

  const run = db.transaction(() => {
    db.exec(SCHEMA_SQL);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  run();
  probe(db);
  return { from, to: SCHEMA_VERSION };
}

/** Integrity probe: the tables must exist and foreign keys must hold (§7.2 rule 5). */
export function probe(db: Db): void {
  const present = new Set(
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => (row as { name: string }).name),
  );
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
  if (missing.length > 0) throw new Error(`schema probe: missing tables ${missing.join(', ')}`);

  const foreignKeyProblems = db.pragma('foreign_key_check') as unknown[];
  if (foreignKeyProblems.length > 0) throw new Error('schema probe: foreign_key_check failed');

  const lane = db.prepare('SELECT COUNT(*) AS n FROM lane').get() as { n: number };
  if (lane.n !== 1) throw new Error(`schema probe: lane must hold exactly one row, found ${lane.n}`);
}
