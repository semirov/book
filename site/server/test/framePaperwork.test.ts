import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { readCommentRow, toCommentDto, type CommentRow } from '../src/comments/repo.ts';
import { runFeedback } from '../src/feedback/cli.ts';
import { bootComments, commentBody, type Harness } from './comments/helpers.ts';

/**
 * BOOK-137 — the frame may be touched, never changed.
 *
 * A reader may file on ch01's opening sentence and on the finale's closing one; the server answers 201,
 * the filing carries the mark `touched`, and the manuscript file stays byte-identical. An
 * accepted filing on the sentence becomes **paperwork**: a `done` change with
 * `outcome='registered'`, a paperwork mode, no step and no ripple — and the thread says
 * «рассмотрено», never «внесено».
 *
 * The two files below carry the canon sentences exactly as `manuscript/ch01.md` and
 * `manuscript/ch42.md` do: a title line, the frame at the edge of the prose, and a paragraph
 * beside it.
 */

const CH01 = [
  'Начало',
  '',
  `${FRAME_FIRST_SENTENCE} Я постоял и вышел.`,
  '',
  'Свет был включён до меня, и это было странно.',
  '',
  'Часы на стене шли.',
  '',
  'Записку оставили на столе.',
].join('\n');
const CH42 = ['Финал', '', 'Свет был включён до меня, и это было странно.', '', FRAME_LAST_SENTENCE].join('\n');

let harness: Harness | null = null;
let dir: string | null = null;

async function boot(chapters: Record<string, string> = { 'ch01.md': CH01, 'ch42.md': CH42 }): Promise<Harness> {
  harness = await bootComments({ chapters });
  dir = mkdtempSync(join(tmpdir(), 'book-frame-'));
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = null;
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function post(h: Harness, body: Record<string, unknown>) {
  return h.app.inject({ method: 'POST', url: '/api/comments', headers: h.headers(), payload: body });
}

function cli(h: Harness, ...argv: string[]): { code: number; out: string[] } {
  const out: string[] = [];
  const code = runFeedback(argv, { db: h.db, dir: dir ?? '', now: h.clock.now, print: (line) => out.push(line) });
  return { code, out };
}

/** The file exactly as it stands on disk — the sentence's letters, byte for byte. */
function file(h: Harness, name: string): string {
  return readFileSync(join(h.fixture.manuscript, name), 'utf8');
}

function blockOf(h: Harness, chapter: number, index: number): { id: string; text: string } {
  return h.db.prepare('SELECT id, text FROM blocks WHERE chapter = ? AND idx = ?').get(chapter, index) as {
    id: string;
    text: string;
  };
}

/** The frame's own paragraph on the finale: the chapter closes on it, so it is the last block. */
function lastBlockOf(h: Harness, chapter: number): { id: string; text: string; idx: number } {
  return h.db
    .prepare('SELECT id, text, idx FROM blocks WHERE chapter = ? ORDER BY idx DESC LIMIT 1')
    .get(chapter) as { id: string; text: string; idx: number };
}

function commentRow(h: Harness, id: string): Record<string, unknown> {
  return h.db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as Record<string, unknown>;
}

/** The row as the storage type, for the DTO helper. */
function typedRow(h: Harness, id: string): CommentRow {
  const row = readCommentRow(h.db, id);
  if (row === undefined) throw new Error(`no comment ${id}`);
  return row;
}

function changeRow(h: Harness, id: string): Record<string, unknown> {
  return h.db.prepare('SELECT * FROM changes WHERE id = ?').get(id) as Record<string, unknown>;
}

describe('a filing on the frozen frame is taken, and changes nothing', () => {
  it('answers 201 on ch01’s frame block, marks it touched, and leaves the file byte-identical', async () => {
    const h = await boot();
    const before = file(h, 'ch01.md');
    const frame = blockOf(h, 1, 0);

    const response = await post(
      h,
      commentBody({ chapter: 1, blockId: frame.id, quote: FRAME_FIRST_SENTENCE, body: 'Первая фраза слишком тихая.' }),
    );

    expect(response.statusCode).toBe(201);
    expect(response.json().comment).toMatchObject({
      chapter: 1,
      status: 'new',
      frame: 'touched',
      anchor: { blockId: frame.id, blockIndex: 0, resolved: true },
    });
    expect(file(h, 'ch01.md')).toBe(before);
    expect(commentRow(h, response.json().comment.id)).toMatchObject({ frame: 'touched', status: 'new' });
  });

  it('answers 201 to a proposed text on the finale and leaves it byte-identical', async () => {
    const h = await boot();
    const before = file(h, 'ch42.md');
    const closer = lastBlockOf(h, 42);

    const response = await post(
      h,
      commentBody({
        chapter: 42,
        blockId: closer.id,
        quote: FRAME_LAST_SENTENCE,
        body: 'Последняя фраза слишком прямая.',
        proposedText: 'Свет погас, потому что стало поздно.',
        interventionKind: 'testimony',
      }),
    );

    expect(response.statusCode).toBe(201);
    expect(response.json().comment).toMatchObject({ chapter: 42, frame: 'touched', status: 'new' });
    expect(response.json().comment.proposedText).toBe('Свет погас, потому что стало поздно.');
    expect(file(h, 'ch42.md')).toBe(before);
  });

  it('records an accepted touched filing as paperwork — done, registered, no step, no ripple', async () => {
    const h = await boot();
    const before = file(h, 'ch01.md');
    const frame = blockOf(h, 1, 0);
    const posted = await post(
      h,
      commentBody({ chapter: 1, blockId: frame.id, quote: FRAME_FIRST_SENTENCE, body: 'Начать надо иначе.' }),
    );
    const id = posted.json().comment.id as string;

    expect(cli(h, 'audit', id, '--verdict', 'FITS').code).toBe(0);
    const decided = cli(h, 'decide', id, 'accepted', '--reason', 'рамка: первая фраза', '--intent', 'первая фраза слишком тихая');
    expect(decided.code).toBe(0);
    // The operator is told the paperwork's own line, never «внесено».
    expect(decided.out.join('\n')).toContain('принято как оформление: рамка книги — фраза не меняется');

    const comment = commentRow(h, id);
    expect(comment).toMatchObject({
      status: 'registered',
      frame: 'touched',
      reason: 'принято как оформление: рамка книги — фраза не меняется',
    });
    expect(comment.decided_at).not.toBeNull();
    // Nothing was written into the book: `applied_*` stay empty for a filing that is a document.
    expect(comment.applied_chapter).toBeNull();
    expect(comment.applied_rev).toBeNull();

    // BOOK-174 §2: paperwork *is* the reading — a document about the phrase, and the reader's
    // card says so. The anchor is ADR-044's: this frame sentence spans two sentences, so the
    // filing keeps its block anchor and the report names the paragraph, never a guessed one.
    expect(comment).toMatchObject({
      disposition: 'through_paper',
      carrier_kind: 'document',
      lock: null,
      sentence_id: null,
    });
    const dto = toCommentDto(h.db, typedRow(h, id));
    // The reading and its carrier are the stored facts; the page makes the one line.
    expect(dto).toMatchObject({ disposition: 'through_paper', carrierKind: 'document' });

    const change = changeRow(h, String(comment.change_id));
    expect(change).toMatchObject({
      kind: 'accepted_comment',
      chapter: 1,
      frame: 'touched',
      frame_mode: 'оформление',
      status: 'done',
      outcome: 'registered',
      premise: 0,
      scope_hint: 'phrase',
    });
    expect(change.reason).toBe('принято как оформление: рамка книги — фраза не меняется');
    expect(change.finished_at).toBe(comment.decided_at);
    // No step, no cascade, no queue: this change was never text.
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM steps').get()).toEqual({ n: 0 });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM cascades').get()).toEqual({ n: 0 });
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE status = 'pending'`).get()).toEqual({ n: 0 });
    // One `registered` event, and never a `queued` one — the lane was not asked.
    expect(h.db.prepare('SELECT type, meta FROM change_events WHERE change_id = ?').all(change.id)).toEqual([
      { type: 'registered', meta: JSON.stringify({ frame: 'touched', mode: 'оформление' }) },
    ]);

    expect(file(h, 'ch01.md')).toBe(before);
  });

  it('keeps the finale’s paperwork on the same terms', async () => {
    const h = await boot();
    const before = file(h, 'ch42.md');
    const closer = lastBlockOf(h, 42);
    const posted = await post(
      h,
      commentBody({ chapter: 42, blockId: closer.id, quote: FRAME_LAST_SENTENCE, body: 'Финал слишком быстрый.' }),
    );
    const id = posted.json().comment.id as string;

    expect(cli(h, 'audit', id, '--verdict', 'FITS').code).toBe(0);
    expect(cli(h, 'decide', id, 'accepted', '--reason', 'рамка: финал', '--intent', 'финал слишком прямой').code).toBe(0);

    expect(closer.idx).toBe(1);
    const comment = commentRow(h, id);
    expect(comment.status).toBe('registered');
    expect(changeRow(h, String(comment.change_id))).toMatchObject({
      chapter: 42,
      frame: 'touched',
      frame_mode: 'оформление',
      status: 'done',
      outcome: 'registered',
    });
    expect(file(h, 'ch42.md')).toBe(before);
  });

  it('records a filing beside the frame as adjacent, and keeps it an ordinary change', async () => {
    const h = await boot();
    const frame = blockOf(h, 1, 0);

    const posted = await post(
      h,
      commentBody({ chapter: 1, blockId: frame.id, quote: 'Я постоял и вышел.', body: 'Здесь нужен вздох.' }),
    );
    expect(posted.statusCode).toBe(201);
    expect(posted.json().comment.frame).toBe('adjacent');
    const id = posted.json().comment.id as string;

    expect(cli(h, 'audit', id, '--verdict', 'FITS').code).toBe(0);
    expect(cli(h, 'decide', id, 'accepted', '--reason', 'вдох после первой фразы', '--intent', 'первый абзац звучит ровнее').code).toBe(0);

    const comment = commentRow(h, id);
    expect(comment.status).toBe('accepted');
    const change = changeRow(h, String(comment.change_id));
    // BOOK-137: the mark travels to the change, but an adjacent filing is text, not paperwork.
    expect(change).toMatchObject({ frame: 'adjacent', status: 'pending', outcome: null, frame_mode: null });
    expect(change.reason).toBeNull();
  });

  it('files paperwork on a basis slot — ch01 holding only its sentence (the launch state)', async () => {
    const h = await boot({ 'ch01.md': FRAME_FIRST_SENTENCE });
    const before = file(h, 'ch01.md');
    const frame = blockOf(h, 1, 0);
    const posted = await post(
      h,
      commentBody({ chapter: 1, blockId: frame.id, quote: FRAME_FIRST_SENTENCE, body: 'С этой фразы всё начинается.' }),
    );
    expect(posted.statusCode).toBe(201);
    expect(posted.json().comment.frame).toBe('touched');
    const id = posted.json().comment.id as string;

    expect(cli(h, 'audit', id, '--verdict', 'FITS').code).toBe(0);
    expect(cli(h, 'decide', id, 'accepted', '--reason', 'рамка: начало', '--intent', 'первая фраза тише').code).toBe(0);

    const comment = commentRow(h, id);
    expect(comment.status).toBe('registered');
    // The slot has no prose to record as a base: the change names revision 0 and no blocks.
    expect(changeRow(h, String(comment.change_id))).toMatchObject({
      frame: 'touched',
      frame_mode: 'оформление',
      status: 'done',
      outcome: 'registered',
      base_rev: 0,
      base_blocks: '[]',
      scope_hint: 'phrase',
    });
    // BOOK-174 §4 lock 3: on a basis-only slot the frame *is* the whole text, so nothing can be
    // said beside it — and the lock's own alternative («документом об этой фразе») is exactly
    // this registration. The paperwork is the answer, not a refusal: the row is `registered`
    // with the paper chain, and the reader's record says how it was read.
    expect(comment).toMatchObject({ disposition: 'through_paper', carrier_kind: 'document', lock: null });
    const dto = toCommentDto(h.db, typedRow(h, id));
    expect(dto).toMatchObject({ disposition: 'through_paper', carrierKind: 'document', status: 'registered' });
    expect(file(h, 'ch01.md')).toBe(before);
  });

  it('takes a filing on a prose block of a written ch01 as untouched, and leaves the frame byte-identical', async () => {
    // BOOK-137: «в первой главе я не могу вмешаться, а должен». `block 3` is far from the
    // sentence, so the mark is `untouched` and the change it becomes is text, not paperwork.
    const h = await boot();
    const before = file(h, 'ch01.md');
    const prose = blockOf(h, 1, 3);
    expect(prose.text).toBe('Записку оставили на столе.');
    expect(prose.text).not.toContain(FRAME_FIRST_SENTENCE);

    const response = await post(
      h,
      commentBody({ chapter: 1, blockId: prose.id, quote: prose.text, body: 'Записка адресована не ему.' }),
    );
    expect(response.statusCode).toBe(201);
    expect(response.json().comment).toMatchObject({ chapter: 1, status: 'new', frame: 'untouched' });

    const id = response.json().comment.id as string;
    expect(cli(h, 'audit', id, '--verdict', 'FITS').code).toBe(0);
    expect(cli(h, 'decide', id, 'accepted', '--reason', 'записка не ему', '--intent', 'записка адресована другому').code).toBe(0);
    const comment = commentRow(h, id);
    expect(comment.status).toBe('accepted');
    expect(changeRow(h, String(comment.change_id))).toMatchObject({
      frame: 'untouched',
      frame_mode: null,
      status: 'pending',
      outcome: null,
    });
    // The chapter's words are untouched, the frame sentence included, byte for byte.
    expect(file(h, 'ch01.md')).toBe(before);
    expect(file(h, 'ch01.md')).toContain(FRAME_FIRST_SENTENCE);
  });

  it('marks a filing on the paragraph after the frame as adjacent', async () => {
    const h = await boot();
    const after = blockOf(h, 1, 1);
    const posted = await post(
      h,
      commentBody({ chapter: 1, blockId: after.id, quote: 'Свет был включён до меня', body: 'Свет включили до него.' }),
    );
    expect(posted.statusCode).toBe(201);
    expect(posted.json().comment.frame).toBe('adjacent');
  });
});
