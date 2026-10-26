import { SCHEMA_SQL, SCHEMA_VERSION, REQUIRED_TABLES, REQUIRED_TRIGGERS, STEPS_COLUMNS, STEPS_TABLE_SQL, BLOCK_VERSIONS_TABLE_SQL, RECONCILES_TABLE_SQL, CHAPTERS_COLUMNS, chaptersTableSql } from './schema.ts';
import type { Db } from './db.ts';
import { sha256Hex } from '../util/hash.ts';

type Migration = { to: number; up: (db: Db) => void };

/**
 * Apply schema migrations in order, then probe the result. `user_version` is the
 * migration cursor; later milestones append steps rather than editing this one.
 *
 * The M0 step (any version < 3 → 3) is deliberately a rebuild: every table of revision
 * 1/2 is a projection of the manuscript or an engine table that has never been written
 * before M3, and the retired `obligations`/`cascade_stages` tables must disappear. Files
 * win for text (§18), so a field install of the skeleton loses only its projection.
 */
const MIGRATIONS: Migration[] = [
  {
    to: 3,
    up(db) {
      dropAllTables(db);
      db.exec(SCHEMA_SQL);
    },
  },
  {
    // M5: a comment carries the reader's suggested wording and the revision its quote came
    // from (§12.2, §6A.7). Idempotent, because a fresh install is created at v4 already.
    to: 4,
    up(db) {
      const columns = new Set(
        (db.pragma('table_info(comments)') as Array<{ name: string }>).map((column) => column.name),
      );
      if (!columns.has('proposed_text')) db.exec('ALTER TABLE comments ADD COLUMN proposed_text TEXT');
      if (!columns.has('base_rev')) db.exec('ALTER TABLE comments ADD COLUMN base_rev INTEGER');
      if (!columns.has('flags')) db.exec(`ALTER TABLE comments ADD COLUMN flags TEXT NOT NULL DEFAULT '[]'`);
    },
  },
  {
    // M6b: every revision names the log entry that produced it, and every paragraph keeps a
    // stable identity (a ULID) across the rewrites that change its text (§6F.2, §6F.3).
    // Idempotent, because a fresh install is created at v5 already.
    to: 5,
    up(db) {
      const columns = new Set(
        (db.pragma('table_info(revisions)') as Array<{ name: string }>).map((column) => column.name),
      );
      if (!columns.has('hseq')) db.exec('ALTER TABLE revisions ADD COLUMN hseq INTEGER');
      db.exec('CREATE INDEX IF NOT EXISTS revisions_hseq ON revisions(chapter, hseq)');
      if (!tableExists(db, 'block_versions')) db.exec(BLOCK_VERSIONS_TABLE_SQL);
    },
  },
  {
    // M7: the operator's mark on a restore (§13.3). A restore is published with
    // `attributed:0` and `cause_kind='restore'`; this table is where `reconcile` records
    // that the gates were re-run. Idempotent, because a fresh install is created at v6.
    to: 6,
    up(db) {
      if (!tableExists(db, 'reconciles')) db.exec(RECONCILES_TABLE_SQL);
    },
  },
  {
    // BOOK-6: a slot may hold only its basis sentence — one paragraph of the frozen frame
    // that the reader must see and that is not written prose. `basis` keeps that apart from
    // `written`. SQLite cannot add a CHECK to an existing column, so the projection table is
    // rebuilt: a migrated install must have the same shape as a fresh one (v7).
    to: 7,
    up(db) {
      const columns = new Set(
        (db.pragma('table_info(chapters)') as Array<{ name: string }>).map((column) => column.name),
      );
      if (columns.has('basis')) return;
      // Foreign keys are already off for the whole migration run. The new table is built
      // under a temporary name and copied, then takes the real name: `blocks`/`revisions`
      // reference `chapters` by name and are never rewritten.
      db.exec(chaptersTableSql('chapters_v7'));
      const shared = CHAPTERS_COLUMNS.filter((column) => columns.has(column));
      db.exec(
        `INSERT INTO chapters_v7 (${shared.join(', ')}) SELECT ${shared.join(', ')} FROM chapters`,
      );
      db.exec('DROP TABLE chapters');
      db.exec('ALTER TABLE chapters_v7 RENAME TO chapters');
    },
  },
  {
    // BOOK-7: the published annotation has its own hash, so an owner hand edit of page 2 is
    // a first-class revision and a later pass can be compared to the exact text that stands.
    // Existing rows are backfilled from the text they already hold; the step is idempotent.
    to: 8,
    up(db) {
      const columns = new Set(
        (db.pragma('table_info(front_matter)') as Array<{ name: string }>).map((column) => column.name),
      );
      if (!columns.has('about_sha256')) {
        db.exec(`ALTER TABLE front_matter ADD COLUMN about_sha256 TEXT NOT NULL DEFAULT ''`);
      }
      const rows = db.prepare('SELECT id, about FROM front_matter').all() as Array<{ id: number; about: string }>;
      const update = db.prepare('UPDATE front_matter SET about_sha256 = ? WHERE id = ?');
      for (const row of rows) update.run(sha256Hex(row.about), row.id);
    },
  },
  {
    // BOOK-9: the auditor's verdict on an intervention, recorded before triage. Four plain
    // rows on the comment; existing comments stay unaudited (null) and therefore cannot be
    // accepted — fail closed, never "assume fits". The CHECK travels with the ADD COLUMN so
    // a migrated install has the same shape as a fresh one.
    to: 9,
    up(db) {
      const columns = new Set(
        (db.pragma('table_info(comments)') as Array<{ name: string }>).map((column) => column.name),
      );
      if (!columns.has('audit_verdict')) {
        db.exec(`ALTER TABLE comments ADD COLUMN audit_verdict TEXT CHECK (audit_verdict IN ('FITS','OFF'))`);
      }
      if (!columns.has('audit_reason')) db.exec('ALTER TABLE comments ADD COLUMN audit_reason TEXT');
      if (!columns.has('audited_at')) db.exec('ALTER TABLE comments ADD COLUMN audited_at TEXT');
      if (!columns.has('audited_by')) db.exec('ALTER TABLE comments ADD COLUMN audited_by TEXT');
    },
  },
];

function tableExists(db: Db, name: string): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
  return row !== undefined;
}

export function migrate(db: Db): { from: number; to: number } {
  const from = Number(db.pragma('user_version', { simple: true }) ?? 0);
  if (from > SCHEMA_VERSION) {
    throw new Error(`database is at schema v${from}, this build understands v${SCHEMA_VERSION}`);
  }

  let current = from;
  const pending = MIGRATIONS.filter((migration) => migration.to > current);
  if (pending.length > 0) {
    // Dropping a table that another table references is legal only with the pragma off;
    // it cannot be toggled inside a transaction, so the transaction is started after it.
    db.pragma('foreign_keys = OFF');
    try {
      const run = db.transaction(() => {
        for (const migration of pending) {
          migration.up(db);
          db.pragma(`user_version = ${migration.to}`);
          current = migration.to;
        }
      });
      run();
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }

  ensureStepLifecycle(db);
  probe(db);
  return { from, to: current };
}

/**
 * M3 needs a step row that exists while the step is open (the lease and both gate verdicts
 * hang off it), so `steps.outcome` is null until close and four lifecycle columns exist.
 * An install created before M3 has the narrower table; it is rebuilt once, here, and the
 * check is idempotent (a fresh database is already in the target shape).
 */
export function ensureStepLifecycle(db: Db): boolean {
  const info = db.pragma('table_info(steps)') as Array<{ name: string; notnull: number }>;
  if (info.length === 0) return false;
  const byName = new Map(info.map((column) => [column.name, column]));
  const missing = STEPS_COLUMNS.filter((column) => !byName.has(column));
  const outcomeNotNull = byName.get('outcome')?.notnull === 1;
  if (missing.length === 0 && !outcomeNotNull) return false;

  const shared = STEPS_COLUMNS.filter((column) => byName.has(column));
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec('ALTER TABLE steps RENAME TO steps_pre_m3');
      db.exec('DROP INDEX IF EXISTS steps_chapter');
      db.exec('DROP INDEX IF EXISTS steps_open');
      db.exec(STEPS_TABLE_SQL);
      db.exec(
        `INSERT INTO steps (${shared.join(', ')}) SELECT ${shared.join(', ')} FROM steps_pre_m3`,
      );
      db.exec('DROP TABLE steps_pre_m3');
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return true;
}

/** Any pre-v3 install is rebuilt, not altered (§4.3 says v1 → v2; rev 4 targets v3). */
function dropAllTables(db: Db): void {
  const names = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all()
    .map((row) => (row as { name: string }).name);
  for (const name of names) {
    db.prepare(`DROP TABLE "${name.replace(/"/gu, '""')}"`).run();
  }
}

/** Integrity probe: the tables and triggers must exist and foreign keys must hold (§7.2 rule 5). */
export function probe(db: Db): void {
  const present = new Set(
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row) => (row as { name: string }).name),
  );
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
  if (missing.length > 0) throw new Error(`schema probe: missing tables ${missing.join(', ')}`);

  const triggers = new Set(
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
      .all()
      .map((row) => (row as { name: string }).name),
  );
  const missingTriggers = REQUIRED_TRIGGERS.filter((trigger) => !triggers.has(trigger));
  if (missingTriggers.length > 0) {
    throw new Error(`schema probe: missing triggers ${missingTriggers.join(', ')}`);
  }

  const foreignKeyProblems = db.pragma('foreign_key_check') as unknown[];
  if (foreignKeyProblems.length > 0) throw new Error('schema probe: foreign_key_check failed');

  const lane = db.prepare('SELECT COUNT(*) AS n FROM lane').get() as { n: number };
  if (lane.n !== 1) throw new Error(`schema probe: lane must hold exactly one row, found ${lane.n}`);
}
