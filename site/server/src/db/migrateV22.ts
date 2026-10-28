/**
 * Migration v22 (BOOK-176, decision BOOK-DOC-69) — the storage machinery's first stage.
 *
 * Five things happen here, and none of them changes the whole-text model the book already has:
 *
 *   · `block_versions` gains `spans`, the JSON list of the edits that produced a version. Every
 *     row written before today reads `'[]'`;
 *   · the ledger's own tables, triggers and the full-text mirror are created from the same
 *     constants a fresh install uses (`ledgerTables.ts`), so an upgraded install and a new one
 *     cannot drift apart;
 *   · every live block gets at least one span, so «the block as it stands» is a fact the ledger
 *     can read instead of an exception every consumer has to handle;
 *   · `block_versions.text` gains one **baseline checkpoint** per chain (ADR-043 D5): the latest
 *     live version stores the paragraph's text, older versions keep `''`. Without it no history
 *     before this migration could be replayed, and the checkpoint rule would start mid-book. A
 *     paragraph that left the book and came back holds the same content-derived id under two
 *     uids (three lines of dialogue in ch01), and both chains get the baseline — otherwise one
 *     of them could never be replayed;
 *   · `chapters.ledger_gap` is measured (ADR-043 D9): the fact-shaped tokens of every chapter
 *     that no fact mention covers. Legacy has no mentions at all, so every date and number counts
 *     — that is the legacy guard's *whole* behaviour. No revision, no warning, no `log_note`: no
 *     land happened, and a fabricated warning would libel a chapter nobody wrote today.
 *
 * **The backfill is a legacy mark, not history.** A block that already has a version keeps it and
 * gains one span whose `cause.kind` is `'legacy'` and whose `invert` is null — the edit that
 * produced it is not known, and inventing one would be worse than saying so. A block with no
 * version at all (a projection written before the chain existed) gets version 1 marked
 * `'introduced'`, attributed to nobody. The step is idempotent: non-empty spans are never
 * overwritten, and a second run finds the row the first one wrote.
 */

import type { Db } from './db.ts';
import { LEDGER_FTS_SQL, LEDGER_TABLES_SQL } from './ledgerTables.ts';
import { newBlockUid } from '../history/blocks.ts';
import { countUnboundFactShaped } from '../ledger/factShaped.ts';
import type { BlockSpan } from '../ledger/spans.ts';

/** `[{"span_id":…}]`? Then the block already has history and the backfill leaves it alone. */
function hasSpans(json: string | null): boolean {
  if (json === null) return false;
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

/**
 * The one legacy span of a block: the paragraph as it stands, at the version that stands.
 * `from`/`to` are 0 (nothing was replaced — the text is what the version introduced) and
 * `invert` is null, because an unknown edit cannot be undone faithfully.
 */
export function legacySpan(
  blockUid: string,
  ver: number,
  blockId: string,
  text: string,
  at: string,
): BlockSpan {
  return {
    span_id: `${blockUid}:${String(ver)}:0`,
    block_id: blockId,
    block_uid: blockUid,
    from: 0,
    to: 0,
    insert: text,
    removed: '',
    cause: { kind: 'legacy', id: null },
    at,
    invert: null,
  };
}

type LiveBlock = { id: string; chapter: number; idx: number; text: string; hash: string; rev: number; updated_at: string };
type LiveChain = { block_id: string; uid: string; ver: number; spans: string | null; at: string };

function liveBlocks(db: Db): LiveBlock[] {
  return db
    .prepare(
      `SELECT b.id, b.chapter, b.idx, b.text, b.hash, c.rev AS rev, c.updated_at AS updated_at
         FROM blocks b JOIN chapters c ON c.n = b.chapter
        ORDER BY b.chapter, b.idx`,
    )
    .all() as LiveBlock[];
}

/**
 * The chains a live block stands on: the latest non-erased version of every `block_uid` whose
 * `block_id` is in the projection. Usually one. **A paragraph that left and came back can hold
 * the same content-derived id under two uids** (the book has three such lines of dialogue in
 * ch01), and both chains are live from the ledger's point of view — so both are read, and
 * neither is left unfillable.
 */
function liveChains(db: Db): Map<string, LiveChain[]> {
  const rows = db
    .prepare(
      `SELECT v.block_id AS block_id, v.block_uid AS uid, v.ver AS ver, v.spans AS spans, v.at AS at
         FROM block_versions v
         JOIN blocks b ON b.id = v.block_id AND b.chapter = v.chapter
        WHERE v.op != 'erased'
          AND v.ver = (SELECT MAX(x.ver) FROM block_versions x
                        WHERE x.block_uid = v.block_uid AND x.op != 'erased')
        ORDER BY v.chapter, b.idx, v.block_uid`,
    )
    .all() as LiveChain[];
  const byBlock = new Map<string, LiveChain[]>();
  for (const row of rows) {
    const list = byBlock.get(row.block_id) ?? [];
    list.push(row);
    byBlock.set(row.block_id, list);
  }
  return byBlock;
}

/**
 * Give every live block a span. Runs after the tables exist, inside the migration's transaction,
 * so a failure leaves neither a half-filled ledger nor a bumped `user_version`.
 */
export function backfillLegacySpans(db: Db): void {
  const updateSpans = db.prepare(`UPDATE block_versions SET spans = ? WHERE block_uid = ? AND ver = ?`);
  const nextHseq = db.prepare('SELECT COALESCE(MAX(hseq), 0) AS hseq FROM events');
  const insertVersion = db.prepare(
    `INSERT INTO block_versions
       (block_uid, ver, chapter, rev, hseq, block_id, text_hash, chars, op, prev_ver, replaced_by,
        change_id, step_id, actor_kind, actor_label, identity_id, at, spans, text)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'introduced', NULL, NULL, NULL, NULL, 'unattributed', 'legacy', NULL, ?, ?, '')`,
  );
  const chains = liveChains(db);

  for (const block of liveBlocks(db)) {
    const list = chains.get(block.id) ?? [];
    if (list.length === 0) {
      // A projection written before the chain existed: version 1 is this very text.
      const uid = newBlockUid(Date.parse(block.updated_at) || 0);
      const span = legacySpan(uid, 1, block.id, block.text, block.updated_at);
      insertVersion.run(
        uid,
        block.chapter,
        block.rev,
        (nextHseq.get() as { hseq: number }).hseq,
        block.id,
        block.hash,
        block.text.length,
        block.updated_at,
        JSON.stringify([span]),
      );
      continue;
    }
    for (const chain of list) {
      if (hasSpans(chain.spans)) continue;
      const span = legacySpan(chain.uid, chain.ver, block.id, block.text, chain.at);
      updateSpans.run(JSON.stringify([span]), chain.uid, chain.ver);
    }
  }
}

/**
 * The baseline checkpoint: the version a block stands at today stores its text, so a replay of
 * any earlier version of that block has a place to start. Written once, by the migration, on the
 * latest live version of every chain regardless of the `ver % 8` rule — that rule governs what
 * later writes add. An ambiguous block id (two chains, see `liveChains`) gets it on both, or one
 * of them would be unreplayable for ever.
 */
export function writeBaselineCheckpoints(db: Db): void {
  const write = db.prepare('UPDATE block_versions SET text = ? WHERE block_uid = ? AND ver = ?');
  const chains = liveChains(db);
  for (const block of liveBlocks(db)) {
    for (const chain of chains.get(block.id) ?? []) write.run(block.text, chain.uid, chain.ver);
  }
}

/** ADR-043 D9: the measured gap of every chapter, written where the sheet and the report read it. */
export function writeLedgerGaps(db: Db): void {
  const chapters = db.prepare('SELECT n FROM chapters ORDER BY n').all() as Array<{ n: number }>;
  const write = db.prepare('UPDATE chapters SET ledger_gap = ? WHERE n = ?');
  for (const chapter of chapters) write.run(countUnboundFactShaped(db, chapter.n), chapter.n);
}

/**
 * The v22 step. Every statement is idempotent, so a database that already ran it — or a fresh
 * install, which gets the tables from `SCHEMA_SQL` before this runs — passes through untouched.
 */
export function migrateV22(db: Db): void {
  const versionColumns = new Set(
    (db.pragma('table_info(block_versions)') as Array<{ name: string }>).map((column) => column.name),
  );
  if (!versionColumns.has('spans')) db.exec(`ALTER TABLE block_versions ADD COLUMN spans TEXT NOT NULL DEFAULT '[]'`);
  if (!versionColumns.has('text')) db.exec(`ALTER TABLE block_versions ADD COLUMN text TEXT NOT NULL DEFAULT ''`);
  const chapterColumns = new Set(
    (db.pragma('table_info(chapters)') as Array<{ name: string }>).map((column) => column.name),
  );
  if (!chapterColumns.has('ledger_gap')) {
    db.exec('ALTER TABLE chapters ADD COLUMN ledger_gap INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(LEDGER_TABLES_SQL);
  db.exec(LEDGER_FTS_SQL);
  backfillLegacySpans(db);
  writeBaselineCheckpoints(db);
  writeLedgerGaps(db);
  // The mirror is filled from the projection it mirrors, not from the triggers it did not see.
  db.exec(`INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')`);
}
