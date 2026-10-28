import { FAILED_ATTEMPT_LINE, type ChangeSummaryDto, type CommentDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  changeState,
  changeWord,
  filingConsequence,
  filingMarginalia,
  filingState,
  HELD_LINE,
  landingReceipt,
  revisionOf,
  sentenceAt,
  STATE_WORDS,
} from './marginalia.ts';
import { changeLines as changeLinesFor } from './changeStatus.ts';
import { clampQuote } from './seam.ts';

/**
 * BOOK-90 / BOOK-137 — the state words and the deck under them.
 *
 * One table for a filing, one for a change: every status has exactly one of «ждёт» · «идёт» ·
 * «внесено» · «рассмотрено», and the second line carries what the word cannot (a refusal, a
 * superseded anchor, a held check, an expired pass, the paperwork mode). The revision object's
 * two rows are resolved on the paragraph's own text, by the same rule the mark uses.
 */

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K4Q7',
    chapter: 8,
    anchor: { blockId: 'ch08#aa11bb22', blockIndex: 1, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: 'Свет был включён до меня.',
    interventionKind: 'testimony',
    status: 'new',
    frame: 'untouched',
    premise: false,
    reason: null,
    createdAt: '2026-10-21T12:03:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    refusal: null,
    attempt: null,
    ...overrides,
  };
}

/** A change summary, only the fields the vocabulary reads. */
function change(overrides: Partial<ChangeSummaryDto> = {}): ChangeSummaryDto {
  return {
    premiseLanded: false,
    sourceCommentId: null,
    id: 'chg_1',
    seq: 4,
    chapter: 8,
    intent: 'оставить одно «слово»',
    premise: false,
    status: 'done',
    frame: 'untouched',
    frameMode: null,
    outcome: 'applied',
    reason: null,
    position: null,
    enqueuedAt: '2026-10-25T12:00:00Z',
    decidedAt: '2026-10-25T12:05:00Z',
    chapters: [8, 7, 9],
    rewritten: [8, 7],
    steps: 3,
    modes: [],
    cascade: null,
    ...overrides,
  };
}

describe('the state words', () => {
  it('are the only vocabulary: ждёт · идёт · внесено · рассмотрено', () => {
    expect(STATE_WORDS).toEqual({ waiting: 'ждёт', working: 'идёт', landed: 'внесено', registered: 'рассмотрено' });
  });

  it('map every filing status onto exactly one of them, the code’s «accepted» being идёт', () => {
    const table: Array<[CommentDto['status'], string]> = [
      ['new', 'ждёт'],
      ['batched', 'идёт'],
      ['delivered', 'идёт'],
      ['accepted', 'идёт'],
      ['applied', 'внесено'],
      // BOOK-137: accepted as paperwork — decided, and nothing was written.
      ['registered', 'рассмотрено'],
      ['superseded', 'ждёт'],
      ['rejected', 'ждёт'],
      ['quarantined', 'ждёт'],
      ['expired', 'ждёт'],
      ['hidden', 'ждёт'],
    ];
    for (const [status, word] of table) expect(filingMarginalia(comment({ status })).word, status).toBe(word);
  });

  it('keeps a premise outside the queue: it waits, and only its first edition is «внесено»', () => {
    expect(filingMarginalia(comment({ premise: true, status: 'accepted' })).word).toBe('ждёт');
    expect(filingMarginalia(comment({ premise: true, status: 'applied', applied: { chapter: 5, rev: 1 } })).word).toBe('внесено');
    expect(filingState({ status: 'something' as CommentDto['status'] })).toBe('waiting');
  });

  it('map a change’s status onto the same words', () => {
    const table: Array<[Partial<ChangeSummaryDto>, string]> = [
      [{ status: 'pending' }, 'идёт'],
      [{ status: 'processing' }, 'идёт'],
      [{ status: 'done' }, 'внесено'],
      // BOOK-137: `done` with `outcome: 'registered'` is a document, not an edit of the text.
      [{ status: 'done', outcome: 'registered', frameMode: 'оформление' }, 'рассмотрено'],
      [{ status: 'stale' }, 'ждёт'],
      [{ status: 'escalated' }, 'ждёт'],
      [{ status: 'failed' }, 'ждёт'],
      [{ status: 'void', outcome: 'dropped' }, 'ждёт'],
      [{ premise: true, status: 'pending' }, 'ждёт'],
      [{ premise: true, status: 'done' }, 'внесено'],
      [{ premise: true, status: 'void', outcome: 'superseded' }, 'ждёт'],
    ];
    for (const [overrides, word] of table) expect(changeWord(change(overrides)), JSON.stringify(overrides)).toBe(word);
    expect(changeState(change({ status: 'done' }))).toBe('landed');
  });
});

describe('the deck’s second line', () => {
  it('says what is still to come or what befell the filing', () => {
    expect(filingConsequence(comment({ status: 'new' }))).toBe('попадёт в триаж');
    expect(filingConsequence(comment({ status: 'batched' }))).toBe('читает триаж');
    expect(filingConsequence(comment({ status: 'delivered' }))).toBe('читает триаж');
    expect(filingConsequence(comment({ status: 'accepted' }))).toBe('правка в очереди на запись');
    expect(filingConsequence(comment({ status: 'accepted', interventionKind: null }))).toBe('замечание в очереди');
    expect(filingConsequence(comment({ status: 'superseded' }))).toBe('снято: текст успел измениться');
    expect(filingConsequence(comment({ status: 'rejected' }))).toBe('отклонено');
    expect(filingConsequence(comment({ status: 'quarantined' }))).toBe(
      'проверяется: замечание сохранено и ждёт человека — из него пока не делают правку',
    );
    expect(filingConsequence(comment({ status: 'expired' }))).toBe('правка не состоялась');
    expect(filingConsequence(comment({ status: 'hidden' }))).toBe('скрыто');
    expect(filingConsequence(comment({ status: 'unknown' as CommentDto['status'] }))).toBe('попадёт в триаж');
  });

  it('names the receipt of a landed intervention, and «замечание сохранено» for a note', () => {
    expect(filingConsequence(comment({ status: 'applied', applied: { chapter: 7, rev: 4 } }))).toBe(
      'внесено в главу 07 · право на ваш текст перешло автору книги',
    );
    expect(filingConsequence(comment({ status: 'applied', interventionKind: null }))).toBe('замечание сохранено');
    // No applied row (a hand-written fixture): the rights line without a chapter is still true.
    expect(filingConsequence(comment({ status: 'applied' }))).toBe('право на ваш текст перешло автору книги');
    expect(landingReceipt(7, 4)).toBe('внесено в главу 07 · право на ваш текст перешло автору книги · ревизия 4');
  });

  it('says what a paperwork filing was filed as, and that the sentence did not change', () => {
    // The comment row carries no mode: its public one-liner is the one source of it, and a row
    // that named none was filed as the default.
    expect(filingConsequence(comment({ status: 'registered', reason: 'принято как оформление: рамка книги — фраза не меняется' }))).toBe(
      'оформление · фраза не изменилась',
    );
    expect(filingConsequence(comment({ status: 'registered', reason: 'принято как поправка: рамка книги — фраза не меняется' }))).toBe(
      'поправка · фраза не изменилась',
    );
    expect(filingConsequence(comment({ status: 'registered' }))).toBe('оформление · фраза не изменилась');
    // A caller that knows the mode (a change's summary) never has it guessed from the line.
    expect(
      filingConsequence({
        ...comment({ status: 'registered', reason: 'принято как оформление: рамка книги — фраза не меняется' }),
        frameMode: 'расхождение',
      }),
    ).toBe('расхождение · фраза не изменилась');
  });

  it('never prints «внесено» for a paperwork filing, nor «рассмотрено» for a landed one', () => {
    const registered = filingMarginalia(comment({ status: 'registered' }));
    const landed = filingMarginalia(comment({ status: 'applied', applied: { chapter: 5, rev: 1 } }));
    expect(registered.word).toBe('рассмотрено');
    expect(registered.state).toBe('registered');
    expect(landed.word).toBe('внесено');
    expect(landed.state).toBe('landed');
  });

  it('keeps a premise’s whole lifecycle on one honest line', () => {
    expect(filingConsequence(comment({ premise: true, status: 'accepted', chapter: 5 }))).toBe('принято в основу, до первой редакции');
    expect(filingConsequence(comment({ premise: true, status: 'applied', applied: { chapter: 5, rev: 2 } }))).toBe(
      'вошло в первую редакцию главы 5',
    );
    expect(filingConsequence(comment({ premise: true, status: 'rejected' }))).toBe('замысел не взят');
    expect(filingConsequence(comment({ premise: true, status: 'superseded' }))).toBe('снято: у главы уже есть замысел');
  });
});

describe('the revision object’s two rows', () => {
  const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет. На столе лежал лист бумаги.';
  const anchor = (overrides: Partial<CommentDto['anchor']> = {}): CommentDto['anchor'] => ({
    blockId: 'ch08#aa11bb22',
    blockIndex: 1,
    quote: 'Её освещал яркий свет.',
    prefix: 'Я вошёл в пустую комнату. ',
    suffix: ' На столе лежал лист бумаги.',
    resolved: true,
    ...overrides,
  });

  it('prints no «стало» when the sentence at the place is unchanged', () => {
    expect(revisionOf(comment({ anchor: anchor() }), TEXT)).toEqual({
      before: 'Её освещал яркий свет.',
      after: null,
      status: 'same',
    });
  });

  it('resolves «стало» by position when the sentence was rewritten', () => {
    // The wording is gone; the stored context still marks the place.
    const rewritten = 'Я вошёл в пустую комнату. Её освещал тусклый свет. На столе лежал лист бумаги.';
    const revision = revisionOf(comment({ anchor: anchor() }), rewritten);
    expect(revision.status).toBe('changed');
    expect(revision.after).toBe('Её освещал тусклый свет.');
    expect(revision.after).not.toBe(revision.before);
    // Never the reader's suggestion: the applied text is the paragraph's own sentence.
    expect(revision.after).not.toBe('Свет был включён до меня.');
  });

  it('prefers the occurrence whose stored context matches when the wording repeats', () => {
    const repeated = 'Её освещал яркий свет. Долгая пауза. И тут Её освещал яркий свет. Конец.';
    const revision = revisionOf(
      comment({
        anchor: anchor({ prefix: 'Долгая пауза. И тут ', suffix: ' Конец.' }),
      }),
      repeated,
    );
    expect(revision.status).toBe('changed');
    expect(revision.after).toBe('И тут Её освещал яркий свет.');
  });

  it('says the text changed when the anchor no longer resolves, never inventing a sentence', () => {
    expect(revisionOf(comment({ anchor: anchor({ resolved: false }) }), TEXT)).toEqual({
      before: 'Её освещал яркий свет.',
      after: null,
      status: 'unresolved',
    });
    // Resolved, but neither the wording nor the stored context survives: no place to resolve.
    const foreign = 'Совсем другой текст без следа прежнего.';
    expect(revisionOf(comment({ anchor: anchor() }), foreign)).toEqual({
      before: 'Её освещал яркий свет.',
      after: null,
      status: 'unresolved',
    });
    expect(revisionOf(comment({ anchor: anchor({ quote: null }) }), TEXT)).toEqual({
      before: null,
      after: null,
      status: 'unresolved',
    });
  });

  it('refuses a repeated context clause: a clause that repeats is not a place', () => {
    // The stored prefix's tail appears twice and no suffix tells the two apart. Printing the
    // neighbour as «стало» would be a lie, so the place is unresolved.
    const repeated = 'Он вошёл. Он вошёл. Дверь была открыта.';
    expect(
      revisionOf(
        comment({ anchor: anchor({ quote: 'Свет был включён.', prefix: 'Он вошёл. ', suffix: '' }) }),
        repeated,
      ),
    ).toEqual({ before: 'Свет был включён.', after: null, status: 'unresolved' });
  });

  it('picks the repeated clause whose stored suffix matches', () => {
    const repeated = 'Он вошёл. Он вошёл. Дверь была открыта.';
    const revision = revisionOf(
      comment({
        anchor: anchor({ quote: 'Свет был включён.', prefix: 'Он вошёл. ', suffix: ' Дверь была открыта.' }),
      }),
      repeated,
    );
    expect(revision.status).toBe('changed');
    expect(revision.after).toBe('Дверь была открыта.');
    expect(revision.after).not.toBe(revision.before);
  });

  it('does not mistake a clamp for a change: a long sentence keeps its place', () => {
    // Distinct words: the clamped quote occurs once, so the place is unambiguous.
    const sentence = `${Array.from({ length: 80 }, (_, index) => `слово${index}`).join(' ')} конец.`;
    const long = comment({
      anchor: anchor({ quote: clampQuote(sentence), prefix: null, suffix: null }),
    });
    expect(revisionOf(long, sentence)).toEqual({
      before: clampQuote(sentence),
      after: null,
      status: 'same',
    });
  });
});

describe('the sentence a filing stands on', () => {
  const TEXT = 'Я вошёл в пустую комнату. Её освещал тусклый свет.';
  const anchor = (overrides: Partial<CommentDto['anchor']> = {}): CommentDto['anchor'] => ({
    blockId: 'ch08#aa11bb22',
    blockIndex: 1,
    quote: 'Её освещал яркий свет.',
    prefix: 'Я вошёл в пустую комнату. ',
    suffix: null,
    resolved: true,
    ...overrides,
  });

  it('names the place even when the wording has been rewritten', () => {
    expect(sentenceAt(TEXT, anchor())).toBe(26);
  });

  it('is the same place the object reads «стало» from', () => {
    const at = sentenceAt(TEXT, anchor());
    const sentence = TEXT.slice(at ?? 0).split('. ')[0];
    expect(sentence).toBe('Её освещал тусклый свет.');
  });

  it('refuses an unresolved anchor and a place it cannot name', () => {
    expect(sentenceAt(TEXT, anchor({ resolved: false }))).toBeNull();
    expect(sentenceAt(TEXT, anchor({ prefix: null, suffix: null }))).toBeNull();
  });
});

describe('the gate’s word beside the state’s word (BOOK-61)', () => {
  it('gives a hold the hold’s line, not the guard’s taxonomy', () => {
    expect(filingConsequence(comment({ status: 'quarantined' }))).toBe(`проверяется: ${HELD_LINE}`);
    expect(filingConsequence(comment({ status: 'quarantined' }))).not.toContain('возможная инструкция');
  });

  it('prints B’s fixed sentence as the line, and C’s word alone', () => {
    // B's sentence is stored in `reason` at the moment of the refusal; the page prints it whole.
    expect(
      filingConsequence(
        comment({ status: 'rejected', refusal: 'rights', reason: 'не принято: пересказ чужого текста без источника' }),
      ),
    ).toBe('не принято: пересказ чужого текста без источника');
    // C keeps its own word here; `commentView` appends the auditor's reason beside it.
    expect(filingConsequence(comment({ status: 'rejected', refusal: 'auditor', reason: 'вне книги' }))).toBe('отклонено');
  });

  it('keeps the state word «ждёт» under every refusal', () => {
    for (const refusal of ['held', 'rights', 'auditor'] as const) {
      expect(filingMarginalia(comment({ status: refusal === 'held' ? 'quarantined' : 'rejected', refusal })).word).toBe(
        'ждёт',
      );
    }
  });
});

/**
 * A filing is one state: its own row plus one fact about its chapter. A failed
 * attempt behind it is not a state, and a premise whose chapter has text has landed.
 */
describe('a failed attempt and a landed premise', () => {
  it('keeps the filing’s word and says the attempt came back empty', () => {
    const failed = filingMarginalia(comment({ status: 'new', attempt: 'failed' }));
    expect(failed).toEqual({ state: 'waiting', word: STATE_WORDS.waiting, consequence: FAILED_ATTEMPT_LINE });
    // A premise still waiting for its first edition says the same: the lane's attempt did not
    // decide anything about the filing.
    expect(filingMarginalia(comment({ premise: true, status: 'accepted', attempt: 'failed' })).consequence).toBe(
      FAILED_ATTEMPT_LINE,
    );
  });

  it('reads a landed premise as entered, with the edition, whatever the row went on to say', () => {
    const landed = change({ premise: true, premiseLanded: true, status: 'void', outcome: 'dropped', reason: FAILED_ATTEMPT_LINE });
    expect(changeState(landed)).toBe('landed');
    expect(changeWord(landed)).toBe(STATE_WORDS.landed);
    // The failed attempt behind a landed premise is stale news, not the premise's line.
    expect(changeLinesFor(landed).second).toBe('вошло в первую редакцию главы 8');
  });
});
