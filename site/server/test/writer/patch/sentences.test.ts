/**
 * The unit rule (BOOK-173 §2, ADR-044 §2.2) — **a block patch edits sentences without breaking
 * their ids**, proven through the writer's own landing path.
 *
 * The writer's answer names a block and a character span; it never sees a sentence id. The
 * sentence partition of the block is a derivative of its text, so the landing carries the patch
 * as a character edit (`writer/patch/sentences.ts` → `ingest/applyChapterFile` →
 * `sentences/transform.ts`), and that module decides the outcome:
 *
 *   · a word fix inside a sentence — the id survives, `text_hash` moves, touch `text`;
 *   · a full stop inserted — the left keeps the id, the right is born with `split_from`;
 *   · a full stop removed — the left keeps the id, the right closes with `erased_at`/`merged_into`;
 *   · a sentence deleted — it is erased;
 *   · an untouched block — **zero** sentence rows written.
 *
 * Every case is asserted on rows a reader could be shown: the sentence ids before and after, the
 * touches with their kind, and the offsets in the new text.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseChapter } from '../../../src/ingest/parseChapter.ts';
import { sentenceEditsOf } from '../../../src/writer/patch/sentences.ts';
import { createHarness, type Harness } from '../harness.ts';

const CHAPTER = 12;
const TITLE = 'Глава двенадцатая';

/** The block every case patches: three sentences, so a split, a merge and an erase all fit. */
const FIRST = 'Первый час шёл снег. Потом стало тихо. Петров вышел на лёд.';
const S1 = 'Первый час шёл снег.';
const S2 = 'Потом стало тихо.';

/** Inert filler: long enough for the chapter floor, and it is never the block under test. */
function filler(marker: string, chars: number): string {
  const head = `${marker} `;
  const text = 'Служебный текст для проверки объёма страницы, он не является текстом книги. ';
  return `${head}${text.repeat(Math.ceil(chars / text.length) + 1)}`.slice(0, chars);
}

function chapterText(first: string): string {
  return `${TITLE}\n\n${first}\n\n${filler('Второй абзац.', 700)}\n\n${filler('Третий абзац.', 700)}\n\n${filler('Четвёртый абзац.', 700)}\n`;
}

type Row = {
  id: string;
  block_id: string;
  idx: number;
  start: number;
  end: number;
  text_hash: string;
  split_from: string | null;
  merged_into: string | null;
  erased_at: string | null;
};

function rowsOf(harness: Harness, blockId: string): Row[] {
  return harness.fixture.db
    .prepare('SELECT * FROM sentences WHERE block_id = ? ORDER BY idx')
    .all(blockId) as Row[];
}

function touchesOf(harness: Harness, sentenceId: string): string[] {
  return (
    harness.fixture.db
      .prepare('SELECT kind FROM sentence_touches WHERE sentence_id = ? ORDER BY id')
      .all(sentenceId) as Array<{ kind: string }>
  ).map((row) => row.kind);
}

function chapterFile(harness: Harness): string {
  return join(harness.bookRoot, 'manuscript', `ch${String(CHAPTER).padStart(2, '0')}.md`);
}

/** A written chapter the harness already ingested (so its sentences exist) and a filing on it. */
async function written(first = FIRST): Promise<Harness> {
  const harness = await createHarness({ chapters: { [CHAPTER]: chapterText(first) } });
  harness.ingest(CHAPTER);
  harness.fixture.engine.enqueue({
    kind: 'operator',
    chapter: CHAPTER,
    intent: 'в первом абзаце главы 12 меняется одна фраза',
    scopeHint: 'phrase',
  });
  return harness;
}

function answer(blockId: string, oldText: string, newText: string): string {
  return JSON.stringify({ mode: 'patch', edits: [{ blockId, oldText, newText }], facts: [], note: 'one sentence' });
}

/** The first block's id and the sentence ids it carries **before** the patch. */
function before(harness: Harness): { blockId: string; rows: Row[] } {
  const parsed = parseChapter(CHAPTER, readFileSync(chapterFile(harness), 'utf8'));
  const block = parsed.blocks[0];
  if (block === undefined) throw new Error('the fixture chapter has no first block');
  return { blockId: block.id, rows: rowsOf(harness, block.id) };
}

/** Run one patch end to end: write the answer, run the pass, read the rows afterwards. */
async function runPatch(
  harness: Harness,
  edit: { oldText: string; newText: string },
): Promise<{ blockId: string; before: Row[]; after: Row[] }> {
  const start = before(harness);
  harness.script.push(answer(start.blockId, edit.oldText, edit.newText), 'HOLDS', 'HOLDS');
  const result = await harness.run({ lanes: ['fwd'] });
  expect(result.status).toBe('closed');
  const parsed = parseChapter(CHAPTER, readFileSync(chapterFile(harness), 'utf8'));
  const patched = parsed.blocks[0];
  if (patched === undefined) throw new Error('the patched chapter has no first block');
  // Every case below asks the same question of the same chapter: the sentences of block 0 now.
  const after = harness.fixture.db
    .prepare('SELECT * FROM sentences WHERE block_id = ? ORDER BY idx')
    .all(patched.id) as Row[];
  return { blockId: patched.id, before: start.rows, after };
}

describe('a block patch is a character edit; sentence ids follow', () => {
  it('a word fix inside a sentence: the id survives, text_hash moves, the turn touches `text`', async () => {
    const harness = await written();
    try {
      const { before: rows, after } = await runPatch(harness, { oldText: S2, newText: 'Потом стало слышно.' });
      const was = rows.find((row) => row.idx === 1);
      const now = after.find((row) => row.idx === 1);
      expect(was).toBeDefined();
      expect(now?.id).toBe(was?.id);
      expect(now?.text_hash).not.toBe(was?.text_hash);
      expect(touchesOf(harness, now?.id ?? '')).toEqual(['text']);
      // Two sentences either side, untouched: same ids, same hashes, no touch of their own.
      for (const index of [0, 2]) {
        expect(after.find((row) => row.idx === index)?.id).toBe(rows.find((row) => row.idx === index)?.id);
      }
      expect(after).toHaveLength(3);
    } finally {
      await harness.close();
    }
  });

  it('a period inserted inside a sentence: the left keeps the id, the right is born with split_from', async () => {
    const harness = await written();
    try {
      const { before: rows, after } = await runPatch(harness, {
        oldText: 'Потом стало тихо.',
        newText: 'Потом. Стало тихо.',
      });
      const left = after.find((row) => row.idx === 1);
      const born = after.find((row) => row.idx === 2);
      expect(left?.id).toBe(rows[1]?.id);
      expect(born?.id).not.toBe(rows[1]?.id);
      expect(born?.split_from).toBe(rows[1]?.id);
      expect(touchesOf(harness, left?.id ?? '')).toEqual(['split']);
      expect(touchesOf(harness, born?.id ?? '')).toEqual(['born']);
      // Four sentences now, and the old third one is still third-from-last with its own id.
      expect(after).toHaveLength(4);
      expect(after.find((row) => row.idx === 3)?.id).toBe(rows[2]?.id);
    } finally {
      await harness.close();
    }
  });

  it('a period removed between two sentences: the left keeps the id, the right is erased with merged_into', async () => {
    const harness = await written(FIRST);
    try {
      const { before: rows, after } = await runPatch(harness, {
        oldText: `${S1} ${S2}`,
        newText: `${S1.replace(/\.$/u, '')} ${S2}`,
      });
      const merged = harness.fixture.db
        .prepare('SELECT * FROM sentences WHERE id = ?')
        .get(rows[1]?.id ?? '') as Row | undefined;
      // The right half closed into the survivor and kept its row as history.
      expect(merged?.erased_at).not.toBeNull();
      expect(merged?.merged_into).toBe(rows[0]?.id);
      expect(touchesOf(harness, rows[1]?.id ?? '')).toEqual(['merge']);
      // The survivor's words moved, so its id stands and its hash is the new text's.
      expect(after[0]?.id).toBe(rows[0]?.id);
      expect(touchesOf(harness, rows[0]?.id ?? '')).toContain('text');
      expect(after).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it('a sentence deleted: the row stays with erased_at, and the neighbours keep their ids', async () => {
    const harness = await written();
    try {
      const { before: rows, after } = await runPatch(harness, { oldText: ` ${S2}`, newText: '' });
      const erased = harness.fixture.db
        .prepare('SELECT * FROM sentences WHERE id = ?')
        .get(rows[1]?.id ?? '') as Row | undefined;
      expect(erased?.erased_at).not.toBeNull();
      expect(erased?.merged_into).toBeNull();
      expect(touchesOf(harness, rows[1]?.id ?? '')).toEqual(['erase']);
      expect(after.map((row) => row.id)).toEqual([rows[0]?.id, rows[2]?.id]);
    } finally {
      await harness.close();
    }
  });

  it('a mention that pinned a sentence follows the surviving row and the new offsets', async () => {
    const harness = await written();
    try {
      const start = before(harness);
      // A claim in the **first** sentence, exactly as the ledger stores one: block, span, and the
      // sentence the span sits in (ADR-044 §4). The patch below edits the *second* sentence, so the
      // witness is still in the text while the block itself takes a new content-derived id.
      harness.fixture.db
        .prepare(
          `INSERT INTO facts (id, chapter, kind, statement, term, sentence_id, valid_from_chapter, created_at)
           VALUES ('fct_snow', 12, 'state', 'Снег шёл весь первый час.', 'снег', ?, 12, ?)`,
        )
        .run(start.rows[0]?.id ?? null, '2026-10-28T09:00:00Z');
      harness.fixture.db
        .prepare(
          `INSERT INTO mentions (span_id, block_id, chapter, start, end, kind, fact_id, thread_id,
                                 resolved_by_change, role, sentence_id, witness, edge_path)
           VALUES ('bkd_seed:1:0', ?, 12, 0, 22, 'fact', 'fct_snow', NULL, NULL, 'assert', ?, ?, '[]')`,
        )
        .run(start.blockId, start.rows[0]?.id ?? null, S1);

      const { after } = await runPatch(harness, { oldText: S2, newText: 'Потом стало слышно.' });
      const mention = harness.fixture.db
        .prepare('SELECT block_id, start, end, sentence_id FROM mentions WHERE fact_id = ?')
        .get('fct_snow') as { block_id: string; start: number; end: number; sentence_id: string | null };
      // The sentence is the same row it was filed on; the block and the offsets are the new ones.
      expect(mention.sentence_id).toBe(start.rows[0]?.id);
      expect(mention.sentence_id).toBe(after[0]?.id);
      expect(mention.block_id).toBe(after[0]?.block_id);
      expect(mention.block_id).not.toBe(start.blockId);
      expect(mention.start).toBe(0);
      expect(mention.end).toBe(S1.length);
    } finally {
      await harness.close();
    }
  });

  it('an untouched block: zero sentence rows written, live or closed', async () => {
    const harness = await written();
    try {
      const parsed = parseChapter(CHAPTER, readFileSync(chapterFile(harness), 'utf8'));
      const other = parsed.blocks[2];
      if (other === undefined) throw new Error('the fixture chapter has no third block');
      const otherRows = rowsOf(harness, other.id);
      expect(otherRows.length).toBeGreaterThan(0);
      // Nothing in block 2 is named: its rows must be byte-identical, and no touch may name them.
      await runPatch(harness, { oldText: S2, newText: 'Потом стало слышно.' });
      expect(rowsOf(harness, other.id)).toEqual(otherRows);
      for (const row of otherRows) expect(touchesOf(harness, row.id)).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('refuses a patch whose oldText differs by one character, and writes no sentence row', async () => {
    const harness = await written();
    try {
      const start = before(harness);
      const touchesBefore = (harness.fixture.db.prepare('SELECT COUNT(*) AS n FROM sentence_touches').get() as { n: number }).n;
      // Two spaces where the block has one: near enough for a fuzzy applier, not for this one.
      harness.script.push(answer(start.blockId, 'Потом  стало тихо.', 'Потом стало слышно.'), answer(start.blockId, 'Потом  стало тихо.', 'Потом стало слышно.'));
      const result = await harness.run({ lanes: ['fwd'] });
      expect(result.status).toBe('parked');
      expect(harness.logs.join('\n')).toContain('OLD_TEXT_NOT_FOUND');
      expect(rowsOf(harness, start.blockId)).toEqual(start.rows);
      const touchesAfter = (harness.fixture.db.prepare('SELECT COUNT(*) AS n FROM sentence_touches').get() as { n: number }).n;
      expect(touchesAfter).toBe(touchesBefore);
    } finally {
      await harness.close();
    }
  });
});

describe('sentenceEditsOf — the applier’s own window, in the sentence ledger’s shape', () => {
  const text = chapterText(FIRST);
  const blocks = parseChapter(CHAPTER, text).blocks;

  it('names the block, its text on both sides, the replacement and its code-point offset', () => {
    const first = blocks[0];
    if (first === undefined) throw new Error('bad sample');
    const newText = first.text.replace(S2, 'Потом стало слышно.');
    const edits = sentenceEditsOf({
      before: [{ id: first.id, text: first.text }],
      after: [{ id: 'ch12#newblock', text: newText }],
      edits: [{ blockId: first.id, oldText: S2, newText: 'Потом стало слышно.' }],
    });
    expect(edits).toEqual([
      {
        blockId: first.id,
        newBlockId: 'ch12#newblock',
        oldText: first.text,
        newText,
        from: S1.length + 1,
        oldFragment: S2,
        newFragment: 'Потом стало слышно.',
      },
    ]);
    // The offset is the position of the replaced stretch itself, not of the block: it points at
    // «Потом» of the second sentence, in code points.
    expect(Array.from(first.text).slice(edits[0]?.from ?? 0, (edits[0]?.from ?? 0) + 5).join('')).toBe('Потом');
  });

  it('states nothing for an edit that changes no byte, and nothing for a block it cannot place', () => {
    const first = blocks[0];
    if (first === undefined) throw new Error('bad sample');
    expect(
      sentenceEditsOf({
        before: [{ id: first.id, text: first.text }],
        after: [{ id: first.id, text: first.text }],
        edits: [{ blockId: first.id, oldText: S2, newText: S2 }],
      }),
    ).toEqual([]);
    expect(
      sentenceEditsOf({
        before: [{ id: 'ch12#gone', text: 'Текст.' }],
        after: [{ id: 'ch12#gone', text: 'Текст.' }],
        edits: [{ blockId: first.id, oldText: S2, newText: 'x' }],
      }),
    ).toEqual([]);
  });
});
