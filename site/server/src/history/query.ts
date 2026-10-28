/**
 * The three public questions of the history (§6F.2–§6F.5): where a paragraph came from,
 * what changed between two moments, and whose text survived.
 *
 * Every answer is a projection of `block_versions` / `overwrites` / `events`; none of them
 * reads a chapter body except the paragraph chain's own copy line, which is metadata.
 */

import type {
  ContributorDto,
  HistoryAuthorKind,
  ContributorsDto,
  HistoryDiffDto,
  HistoryDiffOpDto,
  ParagraphChainDto,
  ParagraphVersionDto,
} from '@book/shared';
import { allChapterNumbers } from '@book/shared';

import type { Db } from '../db/db.ts';
import { OUT_OF_PROCESS_LABEL } from '../ingest/attribution.ts';
import { publicAlias } from '../util/alias.ts';
import { computeShares } from './erosion.ts';

const CLOCK = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Europe/Moscow',
});

/** «14:20» in the site's timezone — the copy the SPEC uses (§6F.3). */
export function clockOf(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return CLOCK.format(date);
}

type VersionRow = {
  block_uid: string;
  ver: number;
  chapter: number;
  rev: number;
  hseq: number;
  block_id: string;
  text_hash: string;
  chars: number;
  op: ParagraphVersionDto['op'];
  prev_ver: number | null;
  replaced_by: string | null;
  change_id: string | null;
  step_id: string | null;
  actor_kind: string;
  actor_label: string;
  identity_id: string | null;
  at: string;
};

function changeSeqMap(db: Db, changeIds: ReadonlyArray<string | null>): Map<string, number> {
  const ids = [...new Set(changeIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT id, seq FROM changes WHERE id IN (${placeholders})`).all(...ids) as Array<{
    id: string;
    seq: number;
  }>;
  return new Map(rows.map((row) => [row.id, row.seq]));
}

function versionDto(row: VersionRow, seqs: ReadonlyMap<string, number>): ParagraphVersionDto {
  return {
    blockUid: row.block_uid,
    ver: row.ver,
    blockId: row.block_id,
    chapter: row.chapter,
    rev: row.rev,
    at: row.at,
    op: row.op,
    textHash: row.text_hash,
    chars: row.chars,
    changeId: row.change_id,
    changeSeq: row.change_id === null ? null : (seqs.get(row.change_id) ?? null),
    stepId: row.step_id,
    actor: {
      kind: row.actor_kind as HistoryAuthorKind,
      // Audit m3: the same public alias the chronicle publishes.
      identityId: row.identity_id === null ? null : publicAlias(row.identity_id),
      label: row.actor_label,
    },
    replacedBy: row.replaced_by,
  };
}

/**
 * The chain's two halves, in the SPEC's words: «переписано … правкой 7 (Аня)» and
 * «было: правка 3 (Аня)» (§6F.3).
 */
function attributionPart(seq: number | null, actor: { label: string } | null): string {
  if (seq === null) return 'вне процесса';
  const who =
    actor !== null && actor.label.length > 0 && actor.label !== OUT_OF_PROCESS_LABEL && actor.label !== 'автор'
      ? ` (${actor.label})`
      : actor !== null && actor.label === 'автор'
        ? ' (автор)'
        : '';
  return `правкой ${seq}${who}`;
}

/** «правка 3 (Аня)» — the previous link of the chain. */
function previousPart(seq: number | null, actor: { label: string } | null): string {
  if (seq === null) return 'вне процесса';
  const who =
    actor !== null && actor.label.length > 0 && actor.label !== OUT_OF_PROCESS_LABEL && actor.label !== 'автор'
      ? ` (${actor.label})`
      : actor !== null && actor.label === 'автор'
        ? ' (автор)'
        : '';
  return `правка ${seq}${who}`;
}

function chainLine(latest: VersionRow, previous: VersionRow | undefined, seqs: Map<string, number>): string {
  const seq = latest.change_id === null ? null : (seqs.get(latest.change_id) ?? null);
  const prevSeq =
    previous === undefined || previous.change_id === null ? null : (seqs.get(previous.change_id) ?? null);
  const before = previous === undefined ? null : previousPart(prevSeq, { label: previous.actor_label });
  const verb =
    latest.op === 'revised'
      ? 'переписано'
      : latest.op === 'erased'
        ? latest.replaced_by === null
          ? 'убрано'
          : 'переписано'
        : 'написано';
  const head = `${verb} в ${clockOf(latest.at)} ${attributionPart(seq, { label: latest.actor_label })}`;
  return before === null ? head : `${head} · было: ${before}`;
}

/**
 * The paragraph chain of one block: by its content-derived id (as a comment stores it) or
 * directly by its uid. The chain is finite by construction — one introduction, at most one
 * continuation per version — so the whole chain can be rendered (§6F.3).
 */
export function readParagraphChain(db: Db, blockIdOrUid: string): ParagraphChainDto | null {
  const isUid = blockIdOrUid.startsWith('bkd_');
  const anchor = isUid
    ? (db.prepare('SELECT block_uid FROM block_versions WHERE block_uid = ? LIMIT 1').get(blockIdOrUid) as
        | { block_uid: string }
        | undefined)
    : (db.prepare('SELECT block_uid FROM block_versions WHERE block_id = ? ORDER BY hseq DESC LIMIT 1').get(
        blockIdOrUid,
      ) as { block_uid: string } | undefined);
  if (anchor === undefined) return null;

  const rows = db
    .prepare('SELECT * FROM block_versions WHERE block_uid = ? ORDER BY ver')
    .all(anchor.block_uid) as VersionRow[];
  if (rows.length === 0) return null;

  const latest = rows[rows.length - 1];
  if (latest === undefined) return null;
  const previous = rows.length > 1 ? rows[rows.length - 2] : undefined;
  const seqs = changeSeqMap(
    db,
    rows.flatMap((row) => [row.change_id]),
  );
  return {
    blockUid: anchor.block_uid,
    blockId: latest.block_id,
    chapter: latest.chapter,
    alive: latest.op !== 'erased',
    versions: rows.map((row) => versionDto(row, seqs)),
    line: chainLine(latest, previous, seqs),
  };
}

type StateRow = {
  block_uid: string;
  block_id: string;
  text_hash: string;
  op: string;
  hseq: number;
  at: string;
  change_id: string | null;
  replaced_by: string | null;
};

function stateAt(db: Db, chapter: number, hseq: number): Map<string, StateRow> {
  const rows = db
    .prepare(
      `SELECT block_uid, block_id, text_hash, op, hseq, at, change_id, replaced_by FROM block_versions
        WHERE chapter = ? AND hseq <= ?`,
    )
    .all(chapter, hseq) as StateRow[];
  const latest = new Map<string, StateRow>();
  for (const row of rows) {
    const known = latest.get(row.block_uid);
    if (known === undefined || row.hseq >= known.hseq) latest.set(row.block_uid, row);
  }
  for (const [uid, row] of latest) if (row.op === 'erased') latest.delete(uid);
  return latest;
}

/**
 * The change log for a span (§6F.2): added, removed and replaced paragraphs between two
 * moments, each with the change that did it. Capped at 500 operations.
 */
export function readDiff(db: Db, from: number, to: number, chapter?: number): HistoryDiffDto {
  const limit = 500;
  const ops: HistoryDiffOpDto[] = [];
  const chapters = chapter === undefined ? allChapterNumbers() : [chapter];
  let truncated = false;

  for (const n of chapters) {
    const before = stateAt(db, n, from);
    const after = stateAt(db, n, to);
    for (const [uid, row] of after) {
      const previous = before.get(uid);
      if (previous !== undefined) {
        if (previous.hseq === row.hseq) continue;
        // The paragraph kept its identity but its text moved: one replacement.
        ops.push({
          op: 'replaced',
          chapter: n,
          blockId: previous.block_id,
          replacedBy: row.block_id,
          textHash: row.text_hash,
          at: row.at,
          changeId: row.change_id,
        });
        continue;
      }
      ops.push({
        op: 'added',
        chapter: n,
        blockId: row.block_id,
        replacedBy: null,
        textHash: row.text_hash,
        at: row.at,
        changeId: row.change_id,
      });
    }
    for (const [uid, row] of before) {
      if (after.has(uid)) continue;
      const gone = db
        .prepare(
          `SELECT replaced_by, hseq, at, change_id FROM block_versions
            WHERE block_uid = ? AND op = 'erased' AND hseq <= ? ORDER BY ver DESC LIMIT 1`,
        )
        .get(uid, to) as { replaced_by: string | null; hseq: number; at: string; change_id: string | null } | undefined;
      ops.push({
        op: gone === undefined || gone.replaced_by === null ? 'removed' : 'replaced',
        chapter: n,
        blockId: row.block_id,
        replacedBy: gone?.replaced_by ?? null,
        textHash: row.text_hash,
        at: gone?.at ?? null,
        changeId: gone?.change_id ?? null,
      });
    }
    if (ops.length >= limit) {
      truncated = true;
      break;
    }
  }

  return { from, to, ops: ops.slice(0, limit), truncated };
}

/**
 * The chronicle's contributor aggregate (§6C.5, §6F.4): the current share only. A day-by-day
 * curve is one reader's own behaviour, so it is served only to them (`MyTraceDto`), never in
 * a public list.
 *
 * The list is the end matter's list with the same shape of exclusion: an opt-out is not named,
 * and neither is the imprint's own reader identity (`is_author = 1`, owner 2026-10-28) — the
 * byline already names him, and two public answers about one measurement must not disagree.
 * Neither exclusion touches `totalChars` or the shares: the author takes the remainder.
 */
export function readContributors(db: Db): ContributorsDto {
  const { totalChars, items } = computeShares(db);
  const out: ContributorDto[] = [];
  for (const item of items) {
    const identity = db
      .prepare('SELECT display_name, hide_from_authors, is_author FROM identities WHERE id = ?')
      .get(item.identityId) as
      | { display_name: string; hide_from_authors: number; is_author: number }
      | undefined;
    // §6C.5: an opt-out keeps the contribution out of the list, not out of the measurement.
    if (identity?.hide_from_authors === 1) continue;
    // The author's own identity: he is a reader, but the byline already names him (owner, 2026-10-28).
    if (identity?.is_author === 1) continue;
    out.push({
      // Audit m3: the identity key joins a session and a rate bucket, so the public list
      // publishes its truncated hash instead (the same alias the end matter uses).
      identityId: publicAlias(item.identityId),
      label: identity?.display_name ?? 'читатель',
      edits: item.edits,
      chars: item.chars,
      share: item.share,
    });
  }
  const measured = db.prepare('SELECT MAX(measured_at) AS at FROM contribution_history').get() as {
    at: string | null;
  };
  return { totalChars, measuredAt: measured.at, items: out };
}
