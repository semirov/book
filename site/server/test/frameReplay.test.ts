import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FRAME_LAST_SENTENCE, TOTAL_CHAPTERS } from '@book/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCommentRow } from '../src/comments/repo.ts';
import { acceptComment } from '../src/feedback/accept.ts';
import { runFeedback } from '../src/feedback/cli.ts';
import { bootComments, commentBody, type Harness } from './comments/helpers.ts';
import { longProse } from './helpers.ts';

/**
 * BOOK-137 — accepting the same paperwork tw**ice is a replay, not a second decision.
 *
 * `register()` writes one change row, one `registered` change event and one `decided` comment
 * event. When the change already exists (the decisions tailer can be handed the same line while
 * the comment is still unlinked), it must write none of them again: the thread would otherwise
 * tell the reader «рассмотрено» twice for one filing.
 *
 * Split from `feedback.test.ts` and `framePaperwork.test.ts` (their 500-line budgets): the case
 * needs a written finale, a filing on its canon close, and the operator's own CLI.
 */

let harness: Harness | null = null;
let dir: string | null = null;

beforeEach(async () => {
  harness = await bootComments({ chapters: { 'ch42.md': longProse(['Служебный текст для проверки.']) } });
  dir = mkdtempSync(join(tmpdir(), 'book-frame-replay-'));
});

afterEach(async () => {
  await harness?.close();
  harness = null;
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function cli(h: Harness, ...argv: string[]): { code: number; out: string[] } {
  const out: string[] = [];
  const code = runFeedback(argv, { db: h.db, dir: dir ?? '', now: h.clock.now, print: (line) => out.push(line) });
  return { code, out };
}

describe('the paperwork is accepted once (BOOK-137)', () => {
  it('writes no second row and no second thread event when the same change id arrives again', async () => {
    const h = harness!;
    const block = h.db.prepare('SELECT id FROM blocks WHERE chapter = ? ORDER BY idx DESC LIMIT 1').get(TOTAL_CHAPTERS) as {
      id: string;
    };
    const posted = await h.app.inject({
      method: 'POST',
      url: '/api/comments',
      headers: h.headers(),
      payload: commentBody({
        chapter: TOTAL_CHAPTERS,
        blockId: block.id,
        quote: FRAME_LAST_SENTENCE,
        body: 'Финал держит всё.',
      }),
    });
    const id = posted.json().comment.id as string;
    expect(posted.json().comment.frame).toBe('touched');
    expect(cli(h, 'audit', id, '--verdict', 'FITS').code).toBe(0);
    expect(cli(h, 'decide', id, 'accepted', '--reason', 'рамка: финал', '--intent', 'финал держит').code).toBe(0);

    const changeId = (h.db.prepare('SELECT change_id FROM comments WHERE id = ?').get(id) as { change_id: string })
      .change_id;
    // The race this guards: the change is written, the comment is not linked back to it yet.
    h.db.prepare('UPDATE comments SET change_id = NULL WHERE id = ?').run(id);

    const replay = acceptComment(h.db, {
      comment: readCommentRow(h.db, id)!,
      intent: 'финал держит',
      at: h.clock.now().toISOString(),
      reason: 'рамка: финал',
      changeId,
    });

    expect(replay).toMatchObject({ changeId, created: false });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 1 });
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM change_events WHERE type = 'registered'`).get()).toEqual({ n: 1 });
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'decided'`).get()).toEqual({ n: 1 });
  });
});
