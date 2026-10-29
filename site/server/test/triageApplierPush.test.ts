/**
 * BOOK-206 M9 — the push at placement is owed only where no change can speak for the filing.
 *
 * `sendPassEvent` writes `push_log` under (identity, chapter), so a «прочитано» push at an
 * accepted placement spent the claim and the later `landed` push for the same chapter was
 * dropped: the reader saw the reading and never «глава N написана». An accepted filing is
 * announced by its change's decision push; a lock refusal — which never becomes a change — and a
 * paperwork placement still push here.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { readCommentRow } from '../src/comments/repo.ts';
import { placeFiling } from '../src/feedback/triageApplier.ts';
import { INTENT, answerOf, asSaid, bootTriage, type Call, type Context } from './filingTriageHarness.ts';

let context: Context | null = null;

afterEach(async () => {
  await context?.close();
  context = null;
});

describe('a placement pushes only where nothing else speaks (BOOK-206 M9)', () => {
  it('an accepted change sends no push: its chapter’s landing push is the reader’s answer', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post();
    context.script.push(answerOf({ itemId: id } as Call, 'FITS', asSaid()));
    await context.pulse();

    const frames: string[] = [];
    const pushes: string[] = [];
    const options = {
      db,
      emit: (type: string) => frames.push(type),
      notify: (commentId: string) => pushes.push(commentId),
      now: h.clock.now,
    };
    expect(placeFiling(options, id)).toBe(true);
    expect(readCommentRow(db, id)).toMatchObject({ status: 'accepted' });
    // The frame still moves the live page; only the push (and its claim) is the change's.
    // BOOK-DOC-84 #17 — the filing's own row also moves on `filing:update`; a frame is not a
    // push, and the push log below is the fact this test is about.
    expect(frames).toEqual(['comment:decision', 'filing:update']);
    expect(pushes).toEqual([]);
  });

  it('a lock refusal still pushes: it never becomes a change, so nothing else can answer it', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post({ body: 'Бумага вместо сцены, другой разговор.' });
    context.script.push(
      answerOf({ itemId: id } as Call, 'OFF', {
        rung: 'inadmissible',
        lock: 'finale',
        intent: INTENT,
        carrier: null,
        refusal: null,
      }),
    );
    await context.pulse();

    const pushes: string[] = [];
    const options = {
      db,
      emit: () => {},
      notify: (commentId: string) => pushes.push(commentId),
      now: h.clock.now,
    };
    expect(placeFiling(options, id)).toBe(true);
    expect(readCommentRow(db, id)).toMatchObject({ status: 'rejected' });
    expect(pushes).toEqual([id]);
  });
});
