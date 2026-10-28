/**
 * The ingest writes sentences (ADR-044 §3.1) — the hole this test exists for: `applyChapterFile`
 * published blocks and nothing else, so a fresh install, a boot scan and every lane landing left
 * live paragraphs with no sentences, filings got `sentence_id = NULL`, and a rewrite left the old
 * ids looking live.
 *
 * These tests drive the real publisher on the real projection (no store calls of their own), so
 * what they prove is the path a chapter file actually takes: create, revise, remove.
 */

import { SEGMENTER_VERSION, splitSentences } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { listBlocks } from '../../src/db/repo/chapters.ts';
import { readCommentRow, resolveAnchor } from '../../src/comments/repo.ts';
import { applyChapterFile, removeChapter } from '../../src/ingest/applyChapter.ts';
import { reconcileChapterSentences } from '../../src/sentences/ingest.ts';
import { listLiveSentences } from '../../src/sentences/store.ts';
import { createFixture, type Fixture } from '../helpers.ts';

const AT = 1_760_000_000_000;
// A chapter file is a title line and then its paragraphs: without the title the first line is
// read as the heading and dropped from the text (§6C.3).
const TITLE = 'Восьмая глава';
const FIRST = `${TITLE}\n\nПервый абзац главы. Он состоит из двух предложений.\n\nВторой абзац главы. И ещё одно предложение.`;
const SECOND =
  `${TITLE}\n\nПервый абзац главы. Он состоит из двух предложений.\n\n` +
  'Второй абзац переписан. В нём теперь три предложения. Третье лишнее.';

function publish(fixture: Fixture, raw: string, at = AT): void {
  applyChapterFile({ db: fixture.db, dataDir: fixture.dataDir, n: 8, raw, mtimeMs: at, nowMs: at });
}

function count(fixture: Fixture, sql: string): number {
  return (fixture.db.prepare(sql).get() as { n: number }).n;
}

describe('applyChapterFile — a published chapter has sentences', () => {
  it('segments every live block on a fresh install, and invents no provenance', () => {
    const fixture = createFixture();
    try {
      publish(fixture, FIRST);
      const blocks = listBlocks(fixture.db, 8);
      expect(blocks).toHaveLength(2);
      for (const block of blocks) {
        const sentences = listLiveSentences(fixture.db, block.id);
        expect(sentences).toHaveLength(splitSentences(block.text).length);
        expect(sentences.every((sentence) => sentence.seg_version === SEGMENTER_VERSION)).toBe(true);
        // Spans of the stored rows are the segmenter's own, in order.
        expect(sentences.map((sentence) => ({ start: sentence.start, end: sentence.end }))).toEqual(
          splitSentences(block.text).map((span) => ({ start: span.start, end: span.end })),
        );
      }
      // Ingest observes a file; it is not a patch, so there is no touch to invent.
      expect(count(fixture, 'SELECT COUNT(*) AS n FROM sentence_touches')).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it('closes the sentences of the paragraph a revision dropped and segments the new one', () => {
    const fixture = createFixture();
    try {
      publish(fixture, FIRST);
      const [kept, dropped] = listBlocks(fixture.db, 8);
      if (kept === undefined || dropped === undefined) throw new Error('fixture published one block');
      const keptSentences = listLiveSentences(fixture.db, kept.id).map((sentence) => sentence.id);
      const droppedSentences = listLiveSentences(fixture.db, dropped.id).map((sentence) => sentence.id);
      expect(keptSentences.length).toBeGreaterThan(0);
      expect(droppedSentences.length).toBeGreaterThan(0);

      publish(fixture, SECOND, AT + 60_000);
      // The paragraph nobody touched keeps its identity and its rows.
      expect(listLiveSentences(fixture.db, kept.id).map((sentence) => sentence.id)).toEqual(keptSentences);
      // The one that left has no live rows left; its rows are history with a close time.
      expect(listLiveSentences(fixture.db, dropped.id)).toEqual([]);
      const closed = fixture.db
        .prepare('SELECT erased_at FROM sentences WHERE block_id = ? ORDER BY idx')
        .all(dropped.id) as Array<{ erased_at: string | null }>;
      expect(closed.length).toBe(droppedSentences.length);
      expect(closed.every((row) => row.erased_at !== null)).toBe(true);

      // The rewritten paragraph is a new block id, segmented from its own text.
      const rewritten = listBlocks(fixture.db, 8).find((block) => block.id !== kept.id);
      if (rewritten === undefined) throw new Error('revision published one block');
      expect(rewritten.id).not.toBe(dropped.id);
      expect(listLiveSentences(fixture.db, rewritten.id)).toHaveLength(splitSentences(rewritten.text).length);
      expect(count(fixture, 'SELECT COUNT(*) AS n FROM sentence_touches')).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it('closes the sentences of a chapter whose file disappeared', () => {
    const fixture = createFixture();
    try {
      publish(fixture, FIRST);
      const ids = listBlocks(fixture.db, 8).map((block) => block.id);
      removeChapter(fixture.db, 8);
      for (const id of ids) {
        expect(listLiveSentences(fixture.db, id)).toEqual([]);
        expect(count(fixture, `SELECT COUNT(*) AS n FROM sentences WHERE block_id = '${id}'`)).toBeGreaterThan(0);
      }
      expect(count(fixture, 'SELECT COUNT(*) AS n FROM blocks')).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it('answers a filing on a rewritten paragraph with resolved:false, not a dead block id', () => {
    const fixture = createFixture();
    try {
      publish(fixture, FIRST);
      const dropped = listBlocks(fixture.db, 8)[1];
      if (dropped === undefined) throw new Error('fixture published one block');
      const sentence = listLiveSentences(fixture.db, dropped.id)[0];
      if (sentence === undefined) throw new Error('fixture segmented no sentence');
      fixture.db
        .prepare(
          `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
           VALUES ('idt_1', 'yandex-1', 'Аня', '2026-10-28T09:00:00Z', '2026-10-28T09:00:00Z')`,
        )
        .run();
      fixture.db
        .prepare(
          `INSERT INTO comments (id, identity_id, chapter, block_id, block_idx, base_rev, quote, sentence_id,
                                 sel_start, sel_end, author, body, body_sha, ip_hash, status, created_at)
           VALUES ('cmt_1', 'idt_1', 8, ?, 1, 1, 'Второй абзац главы.', ?, 0, 5, 'Аня', 'почему так?', 'sha',
                   'iph', 'new', '2026-10-28T09:00:00Z')`,
        )
        .run(dropped.id, sentence.id);

      publish(fixture, SECOND, AT + 60_000);
      const row = readCommentRow(fixture.db, 'cmt_1');
      if (row === undefined) throw new Error('comment vanished');
      const anchor = resolveAnchor(fixture.db, row);
      // The block is gone from the projection and the stored sentence is closed: the filing is
      // unresolved — the quote, never an id that names text nobody can read.
      expect(anchor.resolved).toBe(false);
      expect(anchor.blockId).toBe(dropped.id);
      expect(anchor.sentenceId).toBeUndefined();
    } finally {
      fixture.close();
    }
  });
});

describe('reconcileChapterSentences — the chapter guard', () => {
  it('refuses a block id from another chapter instead of closing or segmenting it', () => {
    const fixture = createFixture();
    try {
      publish(fixture, FIRST);
      const block = listBlocks(fixture.db, 8)[0];
      if (block === undefined) throw new Error('fixture published no block');
      expect(() =>
        reconcileChapterSentences(fixture.db, {
          chapter: 9,
          before: [block],
          after: [],
          at: '2026-10-28T09:00:00Z',
        }),
      ).toThrow(/does not belong to chapter 9/u);
      // The refused call closed nothing: the run is the caller's transaction, not a partial one.
      expect(listLiveSentences(fixture.db, block.id).length).toBeGreaterThan(0);
    } finally {
      fixture.close();
    }
  });
});
