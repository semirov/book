/**
 * Sentence identity through a patch (ADR-044 §2.2/§2.3, BOOK-182 part C).
 *
 * A patch is a **character edit**: it says «this stretch of the paragraph reads differently now».
 * The sentence partition of the paragraph is a derivative of that text, and this module is the one
 * place where the derivative is maintained. There is no `splitSentence()` or `mergeSentence()` in
 * the system and there never will be: a patch that inserts a terminator is a split, one that
 * removes a terminator is a merge, one that deletes a whole sentence is an erase, and the writer
 * never emits a verb because it never sees an id.
 *
 * The rule, one line per outcome (§2.3):
 *
 *   · a word fix inside a sentence — the id survives, `text_hash` moves, touch `text`;
 *   · a sentence whose text survives whole keeps its id even when it changed order (touch
 *     `moved`), which is the one outcome positional matching cannot see;
 *   · text inserted between two sentences — the new segment is born, the neighbours keep their
 *     ids and only their `start`/`end`/`idx` shift, no touch;
 *   · a terminator inserted inside a sentence — the **left** keeps the id (touch `split`), the
 *     right is born with `split_from` (touch `born`);
 *   · a terminator removed between two sentences — the **left** keeps the id (touch `text` when
 *     its hash moved), the right closes with `erased_at` and `merged_into` (touch `merge`);
 *   · a whole sentence deleted — the row stays with `erased_at` (touch `erase`);
 *   · a new segment whose `text_hash` matches an **erased** row of the same chapter — that id is
 *     re-attached, `erased_at` cleared, touch `moved`. That is how «deleted here, pasted there»
 *     reads as a move rather than as a death followed by a birth.
 *
 * How the old boundaries meet the new ones: a new segment whose words match an old sentence
 * **exactly** takes that sentence's id first (a reorder, a move inside the block, a rewrite that
 * kept a sentence) — identity is about the words, never about the slot they sit in. Only what is
 * left is then matched positionally: every remaining old row's `[start, end)` is **transformed** by
 * the replacement (`end <= from` keeps its place, `start >= from + len(old)` shifts by the net
 * delta, an overlap is stretched over the new fragment), and every remaining fresh segment of
 * `splitSentences(newText)` is matched to the old rows it overlaps. That is why an insertion
 * before sentence 3 does not re-key sentences 3–6: their mapped intervals are the same intervals,
 * moved.
 *
 * `idx` is display order, nothing more: it is rewritten everywhere after the transformation, so a
 * sentence that moved down the block keeps its identity and loses only its number. The
 * `(block_id, idx) WHERE erased_at IS NULL` index is why the live rows are **parked** at a far
 * offset before anything is written: a block id is content-derived, so two edited blocks may swap
 * ids, and the finals of one are then written into the space the other still occupies.
 *
 * Nothing here touches `block_versions`, `revisions` or the chapter row: a sentence is a span of
 * the paragraph's current text, and the paragraph's own history is the applier's business.
 */

import { SEGMENTER_VERSION, splitSentences } from '@book/shared';

import type { Db } from '../db/db.ts';
import { cpLength } from '../ledger/spans.ts';
import { ulid } from '../util/ulid.ts';
import { sentenceHash } from './hash.ts';
import { listLiveSentences, touchSentence, type SentenceRow } from './store.ts';

/** One edited block, as `applyPatch` resolved it: the replacement, and the text on both sides. */
export type SentencePatchEdit = {
  /** The block as the patch found it — the id the old sentence rows still carry. */
  blockId: string;
  /** The block as it stands after the patch; content-derived, so it may be a neighbour's old id. */
  newBlockId: string;
  /** The block's text before the patch — the frame `from` is measured in. */
  oldText: string;
  /** The block's text after the patch. */
  newText: string;
  /** Code-point offset of the replaced stretch in `oldText` — the span's own coordinates. */
  from: number;
  /** The text that goes: `edit.oldText`. */
  oldFragment: string;
  /** The text that comes: `edit.newText`. */
  newFragment: string;
};

/** The sentence side of one patch: every edited block of the chapter, and who did it. */
export type SentencePatchInput = {
  db: Db;
  chapter: number;
  /** The change that caused the patch; null for an operator's act or a pass with no change. */
  changeId: string | null;
  /** The revision's ISO moment — the `at` of every row this writes. */
  at: string;
  edits: ReadonlyArray<SentencePatchEdit>;
};

/** What one patch did to the chapter's sentences, one counter per outcome of §2.3. */
export type SentencePatchResult = {
  births: number;
  texts: number;
  moved: number;
  splits: number;
  merges: number;
  erased: number;
};

/** The offset the live rows are parked at while their finals are being written. */
const PARK_OFFSET = 1_000_000;

const IDENTITY_COLUMNS =
  'id, block_id, idx, start, end, text_hash, seg_version, split_from, merged_into, erased_at';

type Interval = { start: number; end: number };

type Mapped = { row: SentenceRow; interval: Interval };

type PairPlan = {
  row: SentenceRow;
  index: number;
  interval: Interval;
  textHash: string;
  /** `moved` for an unchanged sentence that changed order; null when its place did not change. */
  touch: 'text' | 'split' | 'moved' | null;
};

type ClosePlan = { row: SentenceRow; into: string | null; place: number };

type BornPlan = { index: number; interval: Interval; textHash: string; splitFrom: string | null };

/**
 * Move every live row of the involved blocks out of the way of the finals. `blockIds` may name the
 * same block twice (a block handing its id to its neighbour); duplicates are parked once.
 */
function parkRows(db: Db, blockIds: ReadonlyArray<string>): void {
  const park = db.prepare('UPDATE sentences SET idx = idx + ? WHERE block_id = ? AND erased_at IS NULL');
  for (const blockId of new Set(blockIds)) park.run(PARK_OFFSET, blockId);
}

/** The replacement as the boundary arithmetic sees it: where, what went, what came. */
type Window = { from: number; removed: string; inserted: string };

/**
 * The replacement in its smallest form: the common head and tail stay outside it. A writer quotes
 * a stretch of context, and a boundary standing inside that context must not be read as part of
 * the edit — an inserted sentence in front of «Пятое» is an insertion at the start of «Пятое»,
 * whatever three words of context the patch carried. `from` stays in the block's code points.
 */
function minimalWindow(edit: SentencePatchEdit): Window | null {
  const before = Array.from(edit.oldFragment);
  const after = Array.from(edit.newFragment);
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  const removed = before.slice(head, before.length - tail).join('');
  const inserted = after.slice(head, after.length - tail).join('');
  // The two texts are the same text: nothing about the block's sentences moved.
  if (removed === '' && inserted === '') return null;
  return { from: edit.from + head, removed, inserted };
}

/**
 * Where an old sentence sits after the replacement, in the replacement's smallest window.
 *
 * Three cases: the sentence is before the edit and keeps its place, it is after the edit and
 * shifts by the net delta, or the edit reaches into it and its interval is stretched to cover
 * what was put there. The last case is what carries a word fix — and, when the inserted text
 * holds a terminator of its own, what the fresh segmentation is then free to read as a split.
 */
function mapInterval(row: SentenceRow, window: Window, oldLength: number): Interval {
  const from = Math.max(0, Math.min(window.from, oldLength));
  const removed = cpLength(window.removed);
  const inserted = cpLength(window.inserted);
  const to = from + removed;
  const delta = inserted - removed;
  if (row.end <= from) return { start: row.start, end: row.end };
  if (row.start >= to) return { start: row.start + delta, end: row.end + delta };
  return {
    start: Math.min(row.start, from),
    end: Math.max(row.end + delta, from + inserted),
  };
}

/** Do two half-open intervals share a character? */
function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** The display slot a closing row keeps: the new segment that took its place, else past the end. */
function placeOf(segments: ReadonlyArray<Interval>, at: number): number {
  const index = segments.findIndex((segment) => segment.end > at);
  return index === -1 ? segments.length : index;
}

/**
 * Transform every edited block's live sentences, inside the transaction the caller already opened.
 *
 * The live rows are read **before** the first write and the parking happens before the first
 * transform: a block id is content-derived, so a patch may give one block's id to another, and a
 * later read would then mistake the neighbour's fresh rows for its own.
 */
export function applySentencePatch(input: SentencePatchInput): SentencePatchResult {
  const result: SentencePatchResult = { births: 0, texts: 0, moved: 0, splits: 0, merges: 0, erased: 0 };
  if (input.edits.length === 0) return result;

  const windows = new Map<string, Window | null>();
  const liveOf = new Map<string, SentenceRow[]>();
  for (const edit of input.edits) {
    windows.set(edit.blockId, minimalWindow(edit));
    liveOf.set(edit.blockId, listLiveSentences(input.db, edit.blockId));
  }
  // A block whose text did not move keeps its rows exactly where they are: it is not parked and
  // not written, so a patch that repeats a paragraph writes no sentence row at all.
  parkRows(
    input.db,
    input.edits
      .filter((edit) => windows.get(edit.blockId) != null)
      .flatMap((edit) => [edit.blockId, edit.newBlockId]),
  );
  for (const edit of input.edits) {
    transformBlock(input, edit, windows.get(edit.blockId) ?? null, liveOf.get(edit.blockId) ?? [], result);
  }
  return result;
}

/** One block: plan against its old rows, then write in the order the unique index allows. */
function transformBlock(
  input: SentencePatchInput,
  edit: SentencePatchEdit,
  window: Window | null,
  live: ReadonlyArray<SentenceRow>,
  result: SentencePatchResult,
): void {
  const db = input.db;
  const segments = splitSentences(edit.newText);

  // A block the applier has never seen rows for is segmented here: the sentence exists from the
  // moment the text does, and every one of them is born because nobody can say it existed before.
  if (live.length === 0) {
    const insert = db.prepare(
      `INSERT INTO sentences (${IDENTITY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    );
    segments.forEach((segment, index) => {
      const id = `snt_${ulid()}`;
      const hash = sentenceHash(segment.text);
      insert.run(id, edit.newBlockId, index, segment.start, segment.end, hash, SEGMENTER_VERSION);
      touchSentence(db, { sentenceId: id, changeId: input.changeId, kind: 'born', at: input.at });
      result.births += 1;
    });
    return;
  }

  // The block's text did not move, so no boundary moved either: the rows stand as they are.
  if (window === null) return;

  // **Exact content first.** A sentence whose words are still there, whole, keeps its id wherever
  // it now stands — a reorder, a move inside the block, a rewritten block that kept some of its
  // sentences. Positional overlap cannot see this: after a reorder the third sentence's slot
  // holds the first sentence's words, and an id handed to a slot would follow the slot. Ties (the
  // same sentence twice) go to the earliest old row and the earliest new segment — stable for a
  // duplicate that simply stays put.
  const pools = new Map<string, SentenceRow[]>();
  for (const row of live) {
    const pool = pools.get(row.text_hash);
    if (pool === undefined) pools.set(row.text_hash, [row]);
    else pool.push(row);
  }
  const exact = new Map<number, SentenceRow>();
  segments.forEach((segment, index) => {
    const row = pools.get(sentenceHash(segment.text))?.shift();
    if (row !== undefined) exact.set(index, row);
  });
  // Their **relative order** is what `moved` means: a sentence pushed down by a neighbour's
  // insertion, split or erase did not move, and one that jumped over a neighbour did. Ranks are
  // taken over the surviving unchanged sentences only, so a sentence born or closed between two of
  // them cannot make its neighbours look moved.
  const rank = new Map([...exact.values()].sort((a, b) => a.idx - b.idx).map((row, position) => [row.id, position]));
  const keepPlans: PairPlan[] = [...exact.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([index, row], position) => {
      const segment = segments[index];
      if (segment === undefined) return [];
      return [
        {
          row,
          index,
          interval: { start: segment.start, end: segment.end },
          textHash: row.text_hash,
          touch: rank.get(row.id) === position ? null : ('moved' as const),
        },
      ];
    });

  // Only what is left goes through the positional rules below.
  const taken = new Set([...exact.values()].map((row) => row.id));
  const mapped: Mapped[] = live
    .filter((row) => !taken.has(row.id))
    .map((row) => ({ row, interval: mapInterval(row, window, cpLength(edit.oldText)) }));
  const byId = new Map(mapped.map((entry) => [entry.row.id, entry]));

  // The overlap graph, then its components: a component is one stretch of the old text and the
  // stretch of the new text that came out of it, and the pairing below happens inside it.
  const newsByOld = new Map<string, number[]>();
  const oldsByNew = new Map<number, string[]>();
  for (const entry of mapped) {
    segments.forEach((segment, index) => {
      if (exact.has(index)) return;
      if (!overlaps(entry.interval, segment)) return;
      newsByOld.set(entry.row.id, [...(newsByOld.get(entry.row.id) ?? []), index]);
      oldsByNew.set(index, [...(oldsByNew.get(index) ?? []), entry.row.id]);
    });
  }

  const closePlans: ClosePlan[] = [];
  const bornPlans: BornPlan[] = [];
  // The exact pairs are settled: marking their segments visited keeps the birth loop below from
  // bringing them a second identity.
  const visited = new Set<string>([...exact.keys()].map((index) => `n:${String(index)}`));

  for (const entry of mapped) {
    if (visited.has(`o:${entry.row.id}`)) continue;
    const olds: string[] = [];
    const news: number[] = [];
    const stack: Array<{ old: string } | { news: number }> = [{ old: entry.row.id }];
    while (stack.length > 0) {
      const node = stack.pop() as { old: string } | { news: number };
      if ('old' in node) {
        if (visited.has(`o:${node.old}`)) continue;
        visited.add(`o:${node.old}`);
        olds.push(node.old);
        for (const index of newsByOld.get(node.old) ?? []) {
          if (!visited.has(`n:${String(index)}`)) stack.push({ news: index });
        }
      } else {
        if (visited.has(`n:${String(node.news)}`)) continue;
        visited.add(`n:${String(node.news)}`);
        news.push(node.news);
        for (const id of oldsByNew.get(node.news) ?? []) {
          if (!visited.has(`o:${id}`)) stack.push({ old: id });
        }
      }
    }

    const ordered = olds
      .map((id) => byId.get(id))
      .filter((found): found is Mapped => found !== undefined)
      .sort((a, b) => a.interval.start - b.interval.start || a.row.idx - b.row.idx);
    news.sort((a, b) => a - b);

    // Every old sentence whose text is gone: it closed where it stood.
    if (news.length === 0) {
      for (const old of ordered) {
        closePlans.push({ row: old.row, into: null, place: placeOf(segments, old.interval.start) });
      }
      continue;
    }

    // Pair the survivors in order of place. One old into many news is a split (the leftmost new
    // keeps the id, the rest are born with `split_from`); many olds into one new is a merge (the
    // leftmost old keeps the id, the rest close into it). A stretch that both split and merged is
    // paired the same way, in order, and its surplus reads as the surplus of the side it is on.
    const paired = Math.min(ordered.length, news.length);
    const splitting = ordered.length === 1 && news.length > 1;
    for (let i = 0; i < paired; i += 1) {
      const old = ordered[i];
      const index = news[i];
      if (old === undefined || index === undefined) continue;
      const segment = segments[index];
      if (segment === undefined) continue;
      const textHash = sentenceHash(segment.text);
      const changed = textHash !== old.row.text_hash;
      keepPlans.push({
        row: old.row,
        index,
        interval: { start: segment.start, end: segment.end },
        textHash,
        touch: !changed ? null : splitting ? 'split' : 'text',
      });
    }
    const survivor = ordered[paired - 1];
    for (const old of ordered.slice(paired)) {
      closePlans.push({
        row: old.row,
        into: survivor?.row.id ?? null,
        place: survivor === undefined ? 0 : (news[paired - 1] ?? 0),
      });
    }
    for (const index of news.slice(paired)) {
      const segment = segments[index];
      if (segment === undefined) continue;
      bornPlans.push({
        index,
        interval: { start: segment.start, end: segment.end },
        textHash: sentenceHash(segment.text),
        splitFrom: survivor?.row.id ?? null,
      });
    }
  }

  // A new segment outside every component is a sentence nobody wrote before.
  segments.forEach((segment, index) => {
    if (visited.has(`n:${String(index)}`)) return;
    bornPlans.push({
      index,
      interval: { start: segment.start, end: segment.end },
      textHash: sentenceHash(segment.text),
      splitFrom: null,
    });
  });

  const updateLive = db.prepare(
    `UPDATE sentences SET block_id = ?, idx = ?, start = ?, end = ?, text_hash = ?, seg_version = ? WHERE id = ?`,
  );
  const close = db.prepare('UPDATE sentences SET erased_at = ?, merged_into = ?, idx = ? WHERE id = ?');
  const revive = db.prepare(
    `UPDATE sentences
        SET block_id = ?, idx = ?, start = ?, end = ?, text_hash = ?, seg_version = ?,
            erased_at = NULL, merged_into = NULL
      WHERE id = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO sentences (${IDENTITY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  );
  // An erased row of this chapter with the same words is the same sentence come back. A row that
  // was **merged** is not a candidate: its words live on inside the survivor, and reviving it
  // would claim two live identities for one stretch of text.
  const findErased = db.prepare(
    `SELECT s.id FROM sentences s
      WHERE s.erased_at IS NOT NULL AND s.merged_into IS NULL AND s.text_hash = ?
        AND EXISTS (SELECT 1 FROM block_versions bv WHERE bv.block_id = s.block_id AND bv.chapter = ?)
      ORDER BY s.erased_at DESC, s.rowid DESC
      LIMIT 1`,
  );

  for (const plan of keepPlans) {
    updateLive.run(
      edit.newBlockId,
      plan.index,
      plan.interval.start,
      plan.interval.end,
      plan.textHash,
      SEGMENTER_VERSION,
      plan.row.id,
    );
    if (plan.touch === null) continue;
    touchSentence(db, { sentenceId: plan.row.id, changeId: input.changeId, kind: plan.touch, at: input.at });
    if (plan.touch === 'text') result.texts += 1;
    else if (plan.touch === 'split') result.splits += 1;
    else result.moved += 1;
  }
  // Closes are written before the births, so a sentence deleted and pasted back inside one patch
  // is found by the re-attachment below instead of being born a second time (ADR-044 T6).
  for (const plan of closePlans) {
    close.run(input.at, plan.into, plan.place, plan.row.id);
    touchSentence(db, {
      sentenceId: plan.row.id,
      changeId: input.changeId,
      kind: plan.into === null ? 'erase' : 'merge',
      at: input.at,
    });
    if (plan.into === null) result.erased += 1;
    else result.merges += 1;
  }
  for (const plan of bornPlans) {
    const erased = findErased.get(plan.textHash, input.chapter) as { id: string } | undefined;
    if (erased !== undefined) {
      revive.run(
        edit.newBlockId,
        plan.index,
        plan.interval.start,
        plan.interval.end,
        plan.textHash,
        SEGMENTER_VERSION,
        erased.id,
      );
      touchSentence(db, { sentenceId: erased.id, changeId: input.changeId, kind: 'moved', at: input.at });
      result.moved += 1;
      continue;
    }
    const id = `snt_${ulid()}`;
    insert.run(
      id,
      edit.newBlockId,
      plan.index,
      plan.interval.start,
      plan.interval.end,
      plan.textHash,
      SEGMENTER_VERSION,
      plan.splitFrom,
    );
    touchSentence(db, { sentenceId: id, changeId: input.changeId, kind: 'born', at: input.at });
    result.births += 1;
  }
}
