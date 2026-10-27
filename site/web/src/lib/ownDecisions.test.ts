import type { MyDecisionDto, MyDecisionsDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  blocksCopy,
  chaptersCopy,
  decisionLine,
  isOwnDecision,
  measuredDayCopy,
  ownCommentIds,
  readerRecordAction,
  shareCopy,
  wavesCopy,
} from './ownDecisions.ts';

/**
 * BOOK-13 — the sentence a reader gets about their own intervention, and the one rule that
 * keeps a broadcast frame from posing as theirs. Pure functions, so the copy is asserted
 * once and the page cannot drift from it.
 */

function applied(overrides: Partial<MyDecisionDto> = {}): MyDecisionDto {
  return {
    commentId: 'cmt_A',
    changeId: 'chg_A',
    chapter: 8,
    intent: 'внести документ о регистрации сенсора',
    premise: false,
    outcome: 'applied',
    reason: null,
    chapters: [7, 8, 9],
    waves: 2,
    blocks: 12,
    shareAtDecision: { share: 0.004, day: '2026-10-25' },
    decidedAt: '2026-10-25T12:30:00Z',
    ...overrides,
  };
}

function record(overrides: Partial<MyDecisionsDto> = {}): MyDecisionsDto {
  return { items: [applied()], open: [], share: 0.004, ...overrides };
}

describe('the summary of a reader’s own intervention (BOOK-13)', () => {
  it('reads «правка внесена · главы 7–9 · волна 2 · решением · изменилось 12 абзацев · ваша доля 0,4 %»', () => {
    expect(decisionLine(applied(), 0.004).text).toBe(
      'правка внесена · главы 7–9 · волна 2 · решением · изменилось 12 абзацев · ваша доля 0,4 %',
    );
    expect(decisionLine(applied(), 0.004).tone).toBe('done');
  });

  it('never prints «1 волна»: one wave is the rule, not news (BOOK-59)', () => {
    const one = decisionLine(applied({ waves: 1 }), 0.004).text;
    expect(one).toBe('правка внесена · главы 7–9 · изменилось 12 абзацев · ваша доля 0,4 %');
    expect(one).not.toContain('волн');
  });

  it('says «частично» when the change had to drop something, and omits numbers that never ran', () => {
    expect(decisionLine(applied({ outcome: 'adapted', waves: 0, blocks: null, chapters: [8] }), 0.004).text).toBe(
      'правка внесена частично · глава 8 · ваша доля 0,4 %',
    );
  });

  it('says «рассмотрено» for a paperwork decision, and never «правка внесена» (BOOK-137)', () => {
    const line = decisionLine(
      applied({
        outcome: 'registered',
        reason: 'принято как оформление: рамка книги — фраза не меняется',
        chapters: [],
        waves: null,
        blocks: null,
        intent: null,
        shareAtDecision: null,
      }),
      0.004,
    );
    expect(line.text).toBe('рассмотрено · принято как оформление: рамка книги — фраза не меняется');
    expect(line.text).not.toContain('внесена');
    expect(line.tone).toBe('done');
  });

  it('counts one changed paragraph in Russian, not «изменилось 1 абзацев»', () => {
    expect(blocksCopy(1)).toBe('изменился 1 абзац');
    expect(blocksCopy(2)).toBe('изменилось 2 абзаца');
    expect(blocksCopy(12)).toBe('изменилось 12 абзацев');
    expect(blocksCopy(0)).toBeNull();
    expect(blocksCopy(null)).toBeNull();
  });

  it('prints the measured day, never the decision moment, when the share moved', () => {
    expect(decisionLine(applied({ shareAtDecision: { share: 0.004, day: '2026-10-20' } }), 0.0025).text).toContain(
      'ваша доля 0,3 % · на 20.10 было 0,4 %',
    );
    expect(shareCopy(applied({ shareAtDecision: null }), 0.0025)).toBe('ваша доля 0,3 %');
    expect(shareCopy(applied({ shareAtDecision: { share: 0.0025, day: '2026-10-24' } }), 0.0025)).toBe(
      'ваша доля 0,3 %',
    );
    expect(measuredDayCopy('2026-10-09')).toBe('09.10');
  });

  it('names the range and the waves only when they exist', () => {
    expect(chaptersCopy([7, 8, 9])).toBe('главы 7–9');
    expect(chaptersCopy([8])).toBe('глава 8');
    expect(chaptersCopy([6, 9])).toBe('главы 6 и 9');
    expect(chaptersCopy([])).toBeNull();
    expect(wavesCopy(1)).toBeNull();
    expect(wavesCopy(0)).toBeNull();
    expect(wavesCopy(2)).toBe('волна 2 · решением');
    expect(wavesCopy(3)).toBe('волна 3 · решением');
    expect(wavesCopy(null)).toBeNull();
  });

  it('gives a refusal its public reason and no invented numbers', () => {
    const line = decisionLine(
      applied({
        outcome: 'refused',
        changeId: null,
        intent: null,
        chapters: [],
        waves: null,
        blocks: null,
        shareAtDecision: null,
        reason: 'правка не про эту книгу: здесь нет утешения',
      }),
      0.004,
    );
    expect(line.text).toBe('правка не принята · правка не про эту книгу: здесь нет утешения');
    expect(line.text).not.toContain('волн');
    expect(line.text).not.toContain('абзац');
    expect(line.text).not.toContain('%');
    expect(line.tone).toBe('stopped');
  });

  it('says a stopped change waits for the author', () => {
    const line = decisionLine(
      applied({ outcome: 'escalated', waves: null, blocks: null, chapters: [], reason: 'дальше нужен автор' }),
      0.004,
    );
    expect(line.text).toBe('правка остановлена · ждёт решения автора · дальше нужен автор');
    expect(line.text).not.toContain('%');
  });

  it('says an accepted change is still waiting, not a result', () => {
    const line = decisionLine(applied({ outcome: 'queued', waves: null, blocks: null, chapters: [], intent: null }), 0.004);
    expect(line.text).toBe('принято · ждёт очереди');
    expect(line.tone).toBe('live');
  });
});

describe('BOOK-7 — a premise in the reader’s own record', () => {
  it('says «принято в основу» while it waits, and never «в очереди»', () => {
    const waiting = applied({
      premise: true,
      outcome: 'queued',
      intent: null,
      chapters: [],
      waves: null,
      blocks: null,
    });
    expect(decisionLine(waiting, 0.004)).toEqual({
      text: 'принято в основу · ждёт первой редакции главы 8',
      tone: 'live',
    });
  });

  it('marks it taken without inventing waves or paragraphs', () => {
    const taken = applied({ premise: true, chapters: [8], waves: null, blocks: null });
    expect(decisionLine(taken, 0.004).text).toBe('замысел учтён · глава 8 · ваша доля 0,4 %');
    expect(decisionLine(taken, 0.004).text).not.toContain('волн');
  });

  it('shows a superseded premise with its own reason, not the «перекрыта» line', () => {
    const superseded = applied({
      premise: true,
      outcome: 'superseded',
      chapters: [],
      waves: null,
      blocks: null,
      reason: 'у главы уже есть замысел',
    });
    expect(decisionLine(superseded, 0.004)).toEqual({
      text: 'замысел снят · у главы уже есть замысел',
      tone: 'stopped',
    });
  });
});

describe('the record’s trigger (BOOK-13)', () => {
  const own = new Set(['cmt_A']);

  it('reloads on a decision frame that names an own comment', () => {
    expect(readerRecordAction({ kind: 'frame', type: 'change:decided', data: { commentId: 'cmt_A' } }, own)).toBe(
      'refresh',
    );
    expect(readerRecordAction({ kind: 'frame', type: 'comment:decision', data: { id: 'cmt_A' } }, own)).toBe(
      'refresh',
    );
  });

  it('ignores a foreign frame and a frame about nobody the viewer knows', () => {
    expect(readerRecordAction({ kind: 'frame', type: 'change:decided', data: { commentId: 'cmt_B' } }, own)).toBe(
      'ignore',
    );
    expect(readerRecordAction({ kind: 'frame', type: 'comment:decision', data: { id: 'cmt_zzz' } }, own)).toBe(
      'ignore',
    );
    expect(readerRecordAction({ kind: 'frame', type: 'change:decided', data: { commentId: null } }, own)).toBe(
      'ignore',
    );
  });

  it('never reacts to another frame type, even one that happens to carry an own id', () => {
    expect(readerRecordAction({ kind: 'frame', type: 'comment:added', data: { id: 'cmt_A' } }, own)).toBe('ignore');
    expect(readerRecordAction({ kind: 'frame', type: 'state:updated', data: {} }, own)).toBe('ignore');
  });

  it('reloads on a reconnect, drops the record for an anonymous one, and follows a post', () => {
    expect(readerRecordAction({ kind: 'hello', signedIn: true }, own)).toBe('refresh');
    expect(readerRecordAction({ kind: 'hello', signedIn: false }, own)).toBe('drop');
    expect(readerRecordAction({ kind: 'posted', signedIn: true }, own)).toBe('refresh');
    expect(readerRecordAction({ kind: 'posted', signedIn: false }, own)).toBe('ignore');
  });
});

describe('own vs foreign (BOOK-13)', () => {
  it('collects the viewer’s own decided and waiting comment ids', () => {
    const ids = ownCommentIds(record({ open: ['cmt_open'] }));
    expect([...ids].sort()).toEqual(['cmt_A', 'cmt_open']);
    expect(ownCommentIds(null).size).toBe(0);
  });

  it('matches a live frame only against the viewer’s own comments', () => {
    const own = new Set(['cmt_A']);
    expect(isOwnDecision({ commentId: 'cmt_A' }, own)).toBe(true);
    expect(isOwnDecision({ id: 'cmt_A' }, own)).toBe(true);
    expect(isOwnDecision({ commentId: 'cmt_B' }, own)).toBe(false);
    expect(isOwnDecision({ id: 'cmt_B' }, own)).toBe(false);
    expect(isOwnDecision({ commentId: null }, own)).toBe(false);
    expect(isOwnDecision(null, own)).toBe(false);
    expect(isOwnDecision({ commentId: 'cmt_A' }, new Set())).toBe(false);
  });
});
