import type { ChangeSummaryDto, CommentDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  changeState,
  changeWord,
  filingConsequence,
  filingMarginalia,
  filingState,
  landingReceipt,
  revisionOf,
  sentenceAt,
  STATE_WORDS,
} from './marginalia.ts';
import { clampQuote } from './seam.ts';

/**
 * BOOK-90 — the three words and the deck under them.
 *
 * One table for a filing, one for a change: every status has exactly one of «ждёт» · «идёт» ·
 * «внесено», and the second line carries what the word cannot (a refusal, a superseded
 * anchor, a held check, an expired pass). The revision object's two rows are resolved on the
 * paragraph's own text, by the same rule the mark uses.
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
    premise: false,
    reason: null,
    createdAt: '2026-10-21T12:03:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    ...overrides,
  };
}

/** A change summary, only the fields the vocabulary reads. */
function change(overrides: Partial<ChangeSummaryDto> = {}): ChangeSummaryDto {
  return {
    id: 'chg_1',
    seq: 4,
    chapter: 8,
    intent: 'оставить одно «слово»',
    premise: false,
    status: 'done',
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

describe('the three words', () => {
  it('are the only vocabulary: ждёт · идёт · внесено', () => {
    expect(STATE_WORDS).toEqual({ waiting: 'ждёт', working: 'идёт', landed: 'внесено' });
  });

  it('map every filing status onto exactly one of them, the code’s «accepted» being идёт', () => {
    const table: Array<[CommentDto['status'], string]> = [
      ['new', 'ждёт'],
      ['batched', 'идёт'],
      ['delivered', 'идёт'],
      ['accepted', 'идёт'],
      ['applied', 'внесено'],
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

  it('map a change’s status onto the same three words', () => {
    const table: Array<[Partial<ChangeSummaryDto>, string]> = [
      [{ status: 'pending' }, 'идёт'],
      [{ status: 'processing' }, 'идёт'],
      [{ status: 'done' }, 'внесено'],
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
    expect(filingConsequence(comment({ status: 'quarantined' }))).toBe('проверяется перед триажем');
    expect(filingConsequence(comment({ status: 'expired' }))).toBe('проход не состоялся');
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
