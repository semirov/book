import { SCHEMA_SQL, SCHEMA_VERSION, REQUIRED_TABLES, REQUIRED_TRIGGERS, STEPS_COLUMNS, STEPS_TABLE_SQL, BLOCK_VERSIONS_TABLE_SQL, RECONCILES_TABLE_SQL, CHAPTERS_COLUMNS, EVENTS_TABLE_SQL, COMMENT_ATTEMPTS_TABLE_SQL, chaptersTableSql, PASS_SPEND_TABLE_SQL, PASS_STAGES_TABLE_SQL } from './schema.ts';
import { backfillRights } from '../rights/backfill.ts';
import type { Db } from './db.ts';
import { sha256Hex } from '../util/hash.ts';
import { widenPassSpend } from './widenPassSpend.ts';
import { widenGateRoles } from './widenGateRoles.ts';
import { widenSpendProvenance } from './widenSpendProvenance.ts';
import { migrateV22 } from './migrateV22.ts';
import { migrateV23 } from './migrateV23.ts';
import { migrateV25 } from './migrateV25.ts';
import { migrateV26 } from './migrateV26.ts';
import { migrateV27 } from './migrateV27.ts';
import { migrateV28 } from './migrateV28.ts';
import { migrateV29 } from './migrateV29.ts';
import { migrateV30 } from './migrateV30.ts';
import { migrateV32 } from './migrateV32.ts';
import { migrateV33 } from './migrateV33.ts';
import { migrateV34 } from './migrateV34.ts';
import { migrateV35 } from './migrateV35.ts';
import { migrateV36 } from './migrateV36.ts';
import { migrateV37 } from './migrateV37.ts';
import { migrateV38 } from './migrateV38.ts';

type Migration = { to: number; up: (db: Db) => void };

/**
 * Apply schema migrations in order, then probe the result. `user_version` is the migration
 * cursor; later milestones append steps rather than editing this one. The M0 step (any version
 * < 3 → 3) is deliberately a rebuild: every table of revision 1/2 is a projection of the
 * manuscript or an engine table never written before M3, the retired `obligations` and
 * `cascade_stages` must disappear, and files win for text (§18).
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
    // M5: a comment carries the suggested wording and the revision its quote came from (§12.2, §6A.7).
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
    // M6b: every revision names the log entry that produced it; every paragraph keeps its ULID (§6F.2, §6F.3).
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
    // M7: the operator's mark on a restore (§13.3) — `reconcile` records that the gates were re-run.
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
  {
    // BOOK-16: an intervention is one of four kinds (BOOK-DOC-4 rule 1). The kind is stored
    // with the comment and copied to the change it becomes, so triage, the auditor and the
    // writer read the same fact. A row stored before BOOK-16 has no kind — null stays valid
    // for that history — while a new intervention must have one (enforced at every boundary,
    // not by the column). The CHECK travels with the ADD COLUMN, so a migrated install has
    // the same shape as a fresh one.
    to: 10,
    up(db) {
      const commentColumns = new Set(
        (db.pragma('table_info(comments)') as Array<{ name: string }>).map((column) => column.name),
      );
      if (!commentColumns.has('intervention_kind')) {
        db.exec(
          `ALTER TABLE comments ADD COLUMN intervention_kind TEXT
             CHECK (intervention_kind IN ('document','decision','testimony','erasure'))`,
        );
      }
      const changeColumns = new Set(
        (db.pragma('table_info(changes)') as Array<{ name: string }>).map((column) => column.name),
      );
      if (!changeColumns.has('intervention_kind')) {
        db.exec(
          `ALTER TABLE changes ADD COLUMN intervention_kind TEXT
             CHECK (intervention_kind IN ('document','decision','testimony','erasure'))`,
        );
      }
    },
  },
  {
    // BOOK-7: an intervention on a chapter that has no text is that chapter's premise, not prose
    // (BOOK-DOC-6). Two additive columns — the change flag and the draft step that consumed it; a
    // comment's premise state is derived from the change, so the comment needs no column of its own.
    // An old database keeps every row; a fresh install is created with both columns already present.
    to: 11,
    up(db) {
      addColumn(db, 'changes', 'premise', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'steps', 'premise_change', 'TEXT REFERENCES changes(id)');
      // One queued premise per chapter is a database fact, not only an application check.
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS changes_premise_pending
           ON changes(chapter) WHERE premise = 1 AND status = 'pending'`,
      );
    },
  },
  {
    // BOOK-18: the derived index may publish one factual statement about a document's
    // status, so the log's vocabulary gains `document.status`. SQLite cannot widen an inline
    // CHECK, so the table is rebuilt with every row, its indexes and both append-only
    // triggers kept; a fresh install is created at v12 already. Idempotent: a v12 table is
    // returned untouched.
    to: 12,
    up(db) {
      const row = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'`)
        .get() as { sql: string } | undefined;
      if (row === undefined || row.sql.includes("'document.status'")) return;
      db.exec('DROP TRIGGER IF EXISTS events_no_update');
      db.exec('DROP TRIGGER IF EXISTS events_no_delete');
      db.exec('DROP INDEX IF EXISTS events_chapter');
      db.exec('DROP INDEX IF EXISTS events_change');
      db.exec('DROP INDEX IF EXISTS events_kind');
      db.exec('DROP INDEX IF EXISTS events_at');
      db.exec('ALTER TABLE events RENAME TO events_v11');
      db.exec(EVENTS_TABLE_SQL);
      db.exec(
        `INSERT INTO events
           (hseq, at, kind, chapter, is_front, rev, change_id, cascade_id, step_id,
            author_kind, identity_id, author_label, payload, prev_hseq)
         SELECT
           hseq, at, kind, chapter, is_front, rev, change_id, cascade_id, step_id,
           author_kind, identity_id, author_label, payload, prev_hseq
         FROM events_v11`,
      );
      db.exec('DROP TABLE events_v11');
    },
  },
  {
    // BOOK-23: a money figure is a measurement only when something priced it, so «priced and
    // free» (0,00 ₽) stops being indistinguishable from «never measured». Three additive
    // columns; rows written before this step get the honest answer — an amount that was
    // actually recorded (>0) is a measurement, and a stored zero was never a price.
    to: 13,
    up(db) {
      for (const table of ['changes', 'steps', 'change_impact']) {
        addColumn(db, table, 'cost_priced', 'INTEGER NOT NULL DEFAULT 0');
        db.exec(`UPDATE ${table} SET cost_priced = 1 WHERE cost_rub > 0`);
      }
    },
  },
  {
    // BOOK-113: the owner must see the effect of a change at once, so one identity may be
    // exempt from the daily edit budget — both counters (identity and network) — while the
    // comment budget still applies. Additive and off by default: every existing reader reads
    // as 0 and keeps the product's one edit a day.
    to: 14,
    up(db) {
      addColumn(db, 'identities', 'edit_exempt', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    // BOOK-61: three gates on a change (BOOK-DOC-42). Gate A's hold and Gate B's verdict are
    // plain comment columns — a hold is data about a row, not a state of its own. The two gate
    // tables widen `role` to the conditional `rights` under a coupled check, which SQLite
    // cannot add in place, so both are rebuilt with every row.
    //
    // `steps.rights_scan` has no statement here on purpose: `ensureStepLifecycle` rebuilds a
    // `steps` table that lacks any column of `STEPS_COLUMNS`, and that rebuild is the fresh
    // install's exact shape. A migrated install and a fresh one therefore agree on both.
    to: 15,
    up(db) {
      addColumn(db, 'comments', 'held_rule', 'TEXT');
      addColumn(db, 'comments', 'held_by', `TEXT CHECK (held_by IN ('filter','classifier','operator'))`);
      addColumn(db, 'comments', 'held_at', 'TEXT');
      addColumn(db, 'comments', 'rights_verdict', `TEXT CHECK (rights_verdict IN ('CLEAR','REFUSED'))`);
      addColumn(db, 'comments', 'rights_rule', 'TEXT');
      addColumn(db, 'comments', 'rights_at', 'TEXT');
      addColumn(db, 'comments', 'rights_by', 'TEXT');
      addColumn(db, 'comments', 'rights_source', `TEXT CHECK (rights_source IN ('scan','model','operator'))`);
      widenGateRoles(db);
    },
  },
  {
    // BOOK-137: the frozen frame may be touched but never changed, so a filing carries how it
    // sat against the canon sentence and a change that touched it carries the paperwork mode it
    // was filed as. Null is the honest answer for a row written before this step (no mark was
    // ever taken); the CHECK travels with the ADD COLUMN, so a migrated install has the same
    // shape as a fresh one.
    to: 16,
    up(db) {
      addColumn(db, 'comments', 'frame', "TEXT CHECK (frame IN ('touched','adjacent','untouched'))");
      addColumn(db, 'changes', 'frame', "TEXT CHECK (frame IN ('touched','adjacent','untouched'))");
      addColumn(
        db,
        'changes',
        'frame_mode',
        "TEXT CHECK (frame_mode IN ('оформление','поправка','расхождение'))",
      );
    },
  },
  {
    // BOOK-117: every stage a pass passed is a row, not a log line (docs/writer-lane.md §3).
    // Additive and guarded: a fresh install is created at the newest version already, and an
    // existing install keeps every row and gains the table the reader's stage stream reads.
    to: 17,
    up(db) {
      if (!tableExists(db, 'pass_stages')) db.exec(PASS_STAGES_TABLE_SQL);
    },
  },
  {
    // BOOK-117: the money ledger — one row per closed pass, and the only source of a spend
    // total. Additive and guarded; the budget's sums and the footer's cost line read it.
    to: 18,
    up(db) {
      if (!tableExists(db, 'pass_spend')) db.exec(PASS_SPEND_TABLE_SQL);
    },
  },
  {
    // BOOK-58: the record of what a reader accepted. Four nullable columns — the terms of the
    // submission (version and hash of the exact text) and, once a variant lands, the moment it was
    // entered with the version that moment accepted. Null is the honest answer for an older row: no
    // terms were recorded, and none are invented now. Additive, so a migrated install equals a fresh one.
    to: 19,
    up(db) {
      addColumn(db, 'comments', 'terms_version', 'TEXT');
      addColumn(db, 'comments', 'terms_sha', 'TEXT');
      addColumn(db, 'comments', 'accepted_at', 'TEXT');
      addColumn(db, 'comments', 'accepted_terms_version', 'TEXT');
    },
  },
  {
    // BOOK-158: a refusal is explained, revisable and bounded — every submission a model may judge
    // is a row in its own ledger, and the money of that judgement is a `triage` pass. Additive; the
    // ledger's `pass` CHECK is widened, which SQLite cannot do in place, so the table is rebuilt with
    // every row and its index kept (BOOK-18/BOOK-43 style), equal to a fresh install index for index.
    to: 20,
    up(db) {
      if (!tableExists(db, 'comment_attempts')) db.exec(COMMENT_ATTEMPTS_TABLE_SQL);
      widenPassSpend(db);
    },
  },
  {
    // BOOK-117 (owner, 2026-10-28): who ran a pass — the writer lane on the pinned model, or a
    // repair closing on the model it used. The ledger keeps the same word. v21, not v20: BOOK-158
    // took 20 first and an install may already have run it.
    to: 21,
    up(db) {
      addColumn(db, 'steps', 'provenance', "TEXT CHECK (provenance IN ('pipeline','operator'))");
      addColumn(db, 'pass_spend', 'provenance', "TEXT CHECK (provenance IN ('pipeline','operator'))");
    },
  },
  // BOOK-176 (BOOK-DOC-69): the span ledger and the mirror, from the constants a fresh install uses.
  { to: 22, up: migrateV22 },
  // The author marker (owner, 2026-10-28): `migrateV23.ts` holds the column, the decision, the backfill.
  { to: 23, up: migrateV23 },
  // The sentence (ADR-044, BOOK-DOC-74). 25, not 24: v24 is ADR-043's, still to be written.
  { to: 25, up: migrateV25 },
  // BOOK-189: the push tables — subscriptions, the claim and the outbox (26: 24 stays ADR-043's).
  { to: 26, up: migrateV26 },
  // BOOK-174: the chain and the counters (27 — v24 is ADR-043's, and the cursor has passed it).
  { to: 27, up: migrateV27 },
  // BOOK-187 (ADR-043 G6, ADR-041 §2.2): the frame, the lane's counters, the transcripts, the deltas.
  { to: 28, up: migrateV28 },
  // BOOK-185 stage 3 (BOOK-DOC-77): `migrateV29.ts` — runs, facts, edges, threads.
  { to: 29, up: migrateV29 },
  // BOOK-206 (ADR-045): `migrateV30.ts` — the claim, the tries, the verdict.
  { to: 30, up: migrateV30 },
  // BOOK-117: `steps.reopened_at` — where the wall's second window starts. Additive and nullable:
  // a row written before a reopen existed was never re-opened, and no value is invented for it.
  { to: 31, up(db) { addColumn(db, 'steps', 'reopened_at', 'TEXT'); } },
  // BOOK-218: `migrateV32.ts` — the filing's own public number, backfilled by the old rowid.
  { to: 32, up: migrateV32 },
  // BOOK-173: `migrateV33.ts` — the frozen plan, its mode, price and verification record
  // (BOOK-206 took 30, BOOK-117's `reopened_at` took 31, BOOK-218's `comments.number` took 32).
  { to: 33, up: migrateV33 },
  // BOOK-209: `migrateV34.ts` — the reader's place, one row per identity (BOOK-173 took 33).
  { to: 34, up: migrateV34 },
  // BOOK-220 (BOOK-DOC-84 §10.8): the ladder's counters, the widening codes, the two stages —
  // 35, after BOOK-209's `reader_places` (34).
  { to: 35, up: migrateV35 },
  // BOOK-222: `migrateV36.ts` — the candidate a pass wrote and the sha its gate read, plus who
  // answered a verdict (`source`). Additive: an old landing keeps its `landed_*` facts
  // (BOOK-173 took 33, BOOK-209 34, BOOK-220's ladder 35).
  { to: 36, up: migrateV36 },
  // BOOK-206 (owner, 2026-10-29): `migrateV37.ts` — the ladder's operator note on the attempt
  // ledger (`widening_note`; BOOK-220's v35 already carries `widened`/`desperate`). Additive.
  { to: 37, up: migrateV37 },
  // BOOK-222 follow-up: `migrateV38.ts` — the patch's character edits held with the candidate,
  // so the publish keeps sentence ids (`steps.candidate_sentences`). Additive.
  { to: 38, up: migrateV38 },
];

/** `ALTER TABLE … ADD COLUMN` unless the column is already there (every step is idempotent). */
function addColumn(db: Db, table: string, column: string, definition: string): void {
  const columns = new Set(
    (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name),
  );
  if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

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
  widenSpendProvenance(db); // BOOK-219: the ledger's CHECK gains `pipeline-estimated`, idempotently.
  // BOOK-61 review B3: a row posted before Gate B existed carries no rights answer, and every
  // gate behind it reads `NULL` as "no answer" — the filing would wait forever. One deterministic
  // pass over the undecided, still-open rows; marked done in `meta`, so a boot costs nothing.
  backfillRights(db, new Date().toISOString());
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
  // BOOK-DOC-84 §10.8: a column appended by a later step (v31's `reopened_at` after v34's own)
  // leaves a shape that holds every column in the wrong order. A migrated install must equal a
  // fresh one, so the repair also runs when the declaration order differs.
  const sameOrder = info.map((column) => column.name).join(',') === STEPS_COLUMNS.join(',');
  if (missing.length === 0 && !outcomeNotNull && sameOrder) return false;

  const shared = STEPS_COLUMNS.filter((column) => byName.has(column));
  db.pragma('foreign_keys = OFF');
  // BOOK-61: without this, `RENAME` rewrites every table that references `steps` — gate
  // verdicts, dispatches, leases — to point at the temporary name, and the drop below
  // orphans them. `arch.mjs`/`probe` then fail `foreign_key_check` on a real upgrade.
  const legacy = Number(db.pragma('legacy_alter_table', { simple: true }) ?? 0);
  db.pragma('legacy_alter_table = ON');
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
    db.pragma(`legacy_alter_table = ${legacy === 1 ? 'ON' : 'OFF'}`);
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
