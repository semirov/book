import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { readMyDecisions } from '../src/authors/decisions.ts';
import { readCommentRow } from '../src/comments/repo.ts';
import { listChanges } from '../src/engineState/changes.ts';
import { acceptComment } from '../src/feedback/accept.ts';
import { runFeedback } from '../src/feedback/cli.ts';
import { DecisionsTailer } from '../src/feedback/decisions.ts';
import { checkManuscript } from '../../scripts/lib/frame.mjs';
import { bootComments, commentBody, type Harness } from './comments/helpers.ts';

/**
 * BOOK-137 — the frame may be touched, never changed.
 *
 * A reader may file on ch01's opening sentence and on ch67's finale; the server answers 201,
 * the filing carries the mark `touched`, and the manuscript file stays byte-identical. An
 * accepted filing on the sentence becomes **paperwork**: a `done` change with
 * `outcome='registered'`, a paperwork mode, no step and no ripple — and the thread says
 * «рассмотрено», never «внесено».
 *
 * The two files below carry the canon sentences exactly as `manuscript/ch01.md` and
 * `manuscript/ch67.md` do: a title line, the frame at the edge of the prose, and a paragraph
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
const CH67 = ['Финал', '', 'Свет был включён до меня, и это было странно.', '', FRAME_LAST_SENTENCE].join('\n');

let harness: Harness | null = null;
let dir: string | null = null;

async function boot(chapters: Record<string, string> = { 'ch01.md': CH01, 'ch67.md': CH67 }): Promise<Harness> {
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

/** The frame's own paragraph on ch67: the chapter closes on it, so it is the last block. */
function lastBlockOf(h: Harness, chapter: number): { id: string; text: string; idx: number } {
  return h.db
    .prepare('SELECT id, text, idx FROM blocks WHERE chapter = ? ORDER BY idx DESC LIMIT 1')
    .get(chapter) as { id: string; text: string; idx: number };
}

function commentRow(h: Harness, id: string): Record<string, unknown> {
  return h.db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as Record<string, unknown>;
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

  it('answers 201 to a proposed text on ch67 and leaves the finale byte-identical', async () => {
    const h = await boot();
    const before = file(h, 'ch67.md');
    const closer = lastBlockOf(h, 67);

    const response = await post(
      h,
      commentBody({
        chapter: 67,
        blockId: closer.id,
        quote: FRAME_LAST_SENTENCE,
        body: 'Последняя фраза слишком прямая.',
        proposedText: 'Свет погас, потому что стало поздно.',
        interventionKind: 'testimony',
      }),
    );

    expect(response.statusCode).toBe(201);
    expect(response.json().comment).toMatchObject({ chapter: 67, frame: 'touched', status: 'new' });
    expect(response.json().comment.proposedText).toBe('Свет погас, потому что стало поздно.');
    expect(file(h, 'ch67.md')).toBe(before);
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

  it('keeps ch67’s paperwork on the same terms', async () => {
    const h = await boot();
    const before = file(h, 'ch67.md');
    const closer = lastBlockOf(h, 67);
    const posted = await post(
      h,
      commentBody({ chapter: 67, blockId: closer.id, quote: FRAME_LAST_SENTENCE, body: 'Финал слишком быстрый.' }),
    );
    const id = posted.json().comment.id as string;

    expect(cli(h, 'audit', id, '--verdict', 'FITS').code).toBe(0);
    expect(cli(h, 'decide', id, 'accepted', '--reason', 'рамка: финал', '--intent', 'финал слишком прямой').code).toBe(0);

    expect(closer.idx).toBe(1);
    const comment = commentRow(h, id);
    expect(comment.status).toBe('registered');
    expect(changeRow(h, String(comment.change_id))).toMatchObject({
      chapter: 67,
      frame: 'touched',
      frame_mode: 'оформление',
      status: 'done',
      outcome: 'registered',
    });
    expect(file(h, 'ch67.md')).toBe(before);
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

  it('marks a filing on the paragraph after the frame as untouched', async () => {
    const h = await boot();
    const after = blockOf(h, 1, 1);
    const posted = await post(
      h,
      commentBody({ chapter: 1, blockId: after.id, quote: 'Свет был включён до меня', body: 'Свет включили до него.' }),
    );
    expect(posted.statusCode).toBe(201);
    expect(posted.json().comment.frame).toBe('untouched');
  });
});

describe('the change record tells the truth about the paperwork', () => {
  /** The public list a reader's history is built from. */
  it('carries the mark and the mode on the summary, and answers a replay idempotently', async () => {
    const h = await boot();
    const frame = blockOf(h, 1, 0);
    const posted = await post(
      h,
      commentBody({ chapter: 1, blockId: frame.id, quote: FRAME_FIRST_SENTENCE, body: 'Первая фраза слишком тихая.' }),
    );
    const id = posted.json().comment.id as string;
    expect(cli(h, 'audit', id, '--verdict', 'FITS').code).toBe(0);
    expect(cli(h, 'decide', id, 'accepted', '--reason', 'рамка: тише', '--intent', 'первая фраза тише').code).toBe(0);

    const [summary] = listChanges(h.db, { chapter: 1 });
    expect(summary).toMatchObject({
      chapter: 1,
      frame: 'touched',
      frameMode: 'оформление',
      status: 'done',
      outcome: 'registered',
      steps: 0,
      position: null,
      cascade: null,
      chapters: [1],
      rewritten: [],
    });

    // The reader's own record says «рассмотрено», never «внесено»: no waves, no blocks, no
    // intent — a paperwork has no text consequence to count.
    const mine = readMyDecisions(h.db, h.identity.id);
    expect(mine.items[0]).toMatchObject({
      commentId: id,
      outcome: 'registered',
      waves: null,
      blocks: null,
      chapters: [],
      intent: null,
    });

    // A replay of the same acceptance answers with the change it already has — no second row,
    // no second event.
    const replay = acceptComment(h.db, {
      comment: readCommentRow(h.db, id)!,
      intent: 'первая фраза тише',
      at: h.clock.now().toISOString(),
      reason: 'рамка: тише',
    });
    expect(replay).toMatchObject({ changeId: summary?.id, created: false });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 1 });
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM change_events WHERE type = 'registered'`).get()).toEqual({ n: 1 });
  });

  it('takes the paperwork mode the triage named, and the default when it named none', async () => {
    const h = await boot();
    const frame = blockOf(h, 1, 0);
    const named = await post(
      h,
      commentBody({ chapter: 1, blockId: frame.id, quote: FRAME_FIRST_SENTENCE, body: 'Начало держит всю книгу.' }),
    );
    const id = named.json().comment.id as string;
    expect(cli(h, 'audit', id, '--verdict', 'FITS').code).toBe(0);

    // An unknown word is refused before anything is written: the mode is a fixed vocabulary.
    const wrong = cli(h, 'decide', id, 'accepted', '--reason', 'рамка', '--intent', 'первая фраза тише', '--mode', 'правка');
    expect(wrong.code).toBe(2);
    expect(commentRow(h, id)).toMatchObject({ status: 'new', decided_at: null });

    const decided = cli(
      h,
      'decide',
      id,
      'accepted',
      '--reason',
      'рамка: поправка',
      '--intent',
      'первая фраза тише',
      '--mode',
      'поправка',
    );
    expect(decided.code).toBe(0);
    const comment = commentRow(h, id);
    expect(comment.status).toBe('registered');
    expect(comment.reason).toBe('принято как поправка: рамка книги — фраза не меняется');
    expect(changeRow(h, String(comment.change_id))).toMatchObject({
      frame: 'touched',
      frame_mode: 'поправка',
      outcome: 'registered',
    });
    // The written decision line carries the mode, so the site's tailer files the same document.
    expect(JSON.parse(readFileSync(join(dir ?? '', 'decisions.jsonl'), 'utf8').trim())).toMatchObject({
      id,
      status: 'accepted',
      mode: 'поправка',
    });
  });

  it('files the mode a decision line names, and the default when a line names none', async () => {
    const h = await boot();
    const frame = blockOf(h, 1, 0);
    const posted = await post(
      h,
      commentBody({ chapter: 1, blockId: frame.id, quote: FRAME_FIRST_SENTENCE, body: 'С этой фразы всё начинается.' }),
    );
    const id = posted.json().comment.id as string;
    expect(cli(h, 'audit', id, '--verdict', 'FITS').code).toBe(0);

    // A decision line is the site's own path to `acceptComment`; `mode` travels in it.
    const tailer = new DecisionsTailer({
      db: h.db,
      dir: dir ?? '',
      emit: () => undefined,
      now: h.clock.now,
      replay: true,
    });
    tailer.prime();
    mkdirSync(dir ?? '', { recursive: true });
    appendFileSync(
      join(dir ?? '', 'decisions.jsonl'),
      `${JSON.stringify({
        id,
        status: 'accepted',
        reason: 'рамка: расхождение',
        intent: 'первая фраза тише',
        at: h.clock.now().toISOString(),
        mode: 'расхождение',
      })}\n`,
      'utf8',
    );
    expect(tailer.poll()).toBe(1);

    const comment = commentRow(h, id);
    expect(comment.status).toBe('registered');
    expect(comment.reason).toBe('принято как расхождение: рамка книги — фраза не меняется');
    expect(changeRow(h, String(comment.change_id))).toMatchObject({
      frame: 'touched',
      frame_mode: 'расхождение',
      outcome: 'registered',
    });

    // A line that names no mode still files the default paperwork, and an unknown word is dropped.
    for (const mode of [undefined, 'нечто']) {
      const other = await post(
        h,
        commentBody({ chapter: 1, blockId: frame.id, quote: FRAME_FIRST_SENTENCE, body: `Ещё одно замечание: ${String(mode)}` }),
      );
      const otherId = other.json().comment.id as string;
      expect(cli(h, 'audit', otherId, '--verdict', 'FITS').code).toBe(0);
      appendFileSync(
        join(dir ?? '', 'decisions.jsonl'),
        `${JSON.stringify({
          id: otherId,
          status: 'accepted',
          reason: 'рамка: по умолчанию',
          intent: 'первая фраза тише',
          at: h.clock.now().toISOString(),
          ...(mode === undefined ? {} : { mode }),
        })}\n`,
        'utf8',
      );
      expect(tailer.poll()).toBe(1);
      const row = commentRow(h, otherId);
      expect(row.status, String(mode)).toBe('registered');
      expect(changeRow(h, String(row.change_id)), String(mode)).toMatchObject({
        frame: 'touched',
        frame_mode: 'оформление',
      });
    }
  });
});

describe('the deploy gate’s own frame check', () => {
  it('passes on the real repository after the whole scenario', () => {
    // `npm run frame:check` in test form: the same module `deploy.sh` runs reads the real
    // manuscript and answers one object per source. Nothing here writes a file.
    const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
    const checks = checkManuscript({ repoRoot }) as Array<{ label: string; ok: boolean; parts: unknown[] }>;
    expect(checks).toHaveLength(2);
    for (const check of checks) {
      expect(check.parts, check.label).toEqual([]);
      expect(check.ok, check.label).toBe(true);
    }
  });
});
