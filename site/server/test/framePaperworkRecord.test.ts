import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { readMyDecisions } from '../src/authors/decisions.ts';
import { readCommentRow } from '../src/comments/repo.ts';
import { listChanges } from '../src/engineState/changes.ts';
import { acceptComment } from '../src/feedback/accept.ts';
import { runFeedback } from '../src/feedback/cli.ts';
import { DecisionsTailer } from '../src/feedback/decisions.ts';
import { bootComments, commentBody, type Harness } from './comments/helpers.ts';

/**
 * BOOK-137 — **the change record tells the truth about the paperwork.**
 *
 * Split from `framePaperwork.test.ts` (the 500-line gate): that file is about a filing stopping at
 * the frame, this one is about what the decision then *says* — the mark and the mode on the change,
 * the reader's own record («рассмотрено», never «внесено»), and the decision line the site's tailer
 * files. The two chapter files carry the canon exactly as `manuscript/ch01.md` and
 * `manuscript/ch42.md` do: a title line, the frame at the edge of the prose, a paragraph beside it.
 */

const CH01 = [
  'Начало',
  '',
  `${FRAME_FIRST_SENTENCE} Я постоял и вышел.`,
  '',
  'Свет был включён до меня, и это было странно.',
].join('\n');
const CH42 = ['Финал', '', 'Свет был включён до меня, и это было странно.', '', FRAME_LAST_SENTENCE].join('\n');

let harness: Harness | null = null;
let dir: string | null = null;

async function boot(): Promise<Harness> {
  harness = await bootComments({ chapters: { 'ch01.md': CH01, 'ch42.md': CH42 } });
  dir = mkdtempSync(join(tmpdir(), 'book-frame-record-'));
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

function blockOf(h: Harness, chapter: number, index: number): { id: string; text: string } {
  return h.db.prepare('SELECT id, text FROM blocks WHERE chapter = ? AND idx = ?').get(chapter, index) as {
    id: string;
    text: string;
  };
}

function commentRow(h: Harness, id: string): Record<string, unknown> {
  return h.db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as Record<string, unknown>;
}

function changeRow(h: Harness, id: string): Record<string, unknown> {
  return h.db.prepare('SELECT * FROM changes WHERE id = ?').get(id) as Record<string, unknown>;
}

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
