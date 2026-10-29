import { describe, expect, it } from 'vitest';
import { STOP_REASONS } from '@book/shared';

import { summarize, type SummarySubject } from '../../src/history/summary.ts';

function subject(overrides: Partial<SummarySubject> = {}): SummarySubject {
  return {
    kind: 'chapter.revised',
    chapter: 9,
    isFront: false,
    rev: 2,
    changeSeq: 7,
    authorKind: 'reader',
    authorLabel: 'Аня',
    payload: {},
    ...overrides,
  };
}

describe('one line per fact (§11.10)', () => {
  it('names the chapter, the change and the reader', () => {
    expect(summarize(subject())).toBe('глава 9 изменена правкой 007 (Аня)');
    expect(summarize(subject({ payload: { kind: 'rewrite' } }))).toBe('глава 9 переписана правкой 007 (Аня)');
    expect(summarize(subject({ kind: 'chapter.created', changeSeq: null }))).toBe('глава 9 написана');
  });

  it('says «правка вне процесса» when no lease owned the write', () => {
    expect(summarize(subject({ changeSeq: null, authorKind: 'unattributed' }))).toBe(
      'глава 9 изменена — правка вне процесса',
    );
  });

  it('names a front revision by the field that moved, and a hand edit as out of process', () => {
    expect(
      summarize(subject({ isFront: true, chapter: null, kind: 'front.revised', payload: { title: 'Новое', titleChanged: true } })),
    ).toBe('название изменилось правкой 007 (Аня)');
    // A file that only tried to rewrite page 2 is a refused attempt, not a title revision.
    expect(
      summarize(
        subject({
          isFront: true,
          chapter: null,
          kind: 'front.revised',
          payload: { title: 'То же', titleChanged: false, annotationRejected: 'FRONT_ANNOTATION_FROZEN' },
        }),
      ),
    ).toBe('страница 2 — основа: переписать не дали правкой 007 (Аня)');
    // BOOK-7: an accepted owner edit moves page 2, and the line says so with the existing wording.
    expect(
      summarize(
        subject({
          isFront: true,
          chapter: null,
          kind: 'front.revised',
          changeSeq: null,
          authorKind: 'unattributed',
          payload: { title: 'Новое', titleChanged: true, annotationChanged: true },
        }),
      ),
    ).toBe('первая страница изменилась — правка вне процесса');
  });

  it('never repeats a gate finding or a role: a verdict is only «замечание сохранено»', () => {
    const line = summarize(
      subject({ kind: 'gate.recorded', payload: { role: 'consultant', findings: 'секрет редактора' } }),
    );
    expect(line).toBe('глава 9: замечание сохранено');
    expect(line).not.toContain('секрет');
    expect(line).not.toContain('консультант');
  });

  it('shows a dropped change with its public reason', () => {
    expect(
      summarize(subject({ kind: 'change.decided', chapter: null, payload: { status: 'void', outcome: 'dropped', reason: 'основа изменилась' } })),
    ).toBe('правка 007 не применена: основа изменилась');
    expect(summarize(subject({ kind: 'change.decided', chapter: null, payload: { status: 'done', outcome: 'applied' } }))).toBe(
      'правка 007 внесена',
    );
    expect(
      summarize(subject({ kind: 'change.decided', chapter: null, payload: { status: 'escalated', outcome: 'origin' } })),
    ).toBe('правка 007 требует решения');
  });

  it('covers the queue, the ripple and the operator facts', () => {
    // BOOK-218 — the chronicle says the book's fact, from the module: no queue to stand in.
    expect(summarize(subject({ kind: 'change.queued', chapter: null }))).toBe('правка 007 ждёт своей главы');
    expect(summarize(subject({ kind: 'change.queued', chapter: null, changeSeq: null }))).toBe('правка ждёт своей главы');
    expect(summarize(subject({ kind: 'change.processing', chapter: null }))).toBe('правка 007 в работе');
    expect(summarize(subject({ kind: 'change.stale', chapter: null }))).toBe('правка 007: основа изменилась');
    expect(summarize(subject({ kind: 'cascade.opened', chapter: null }))).toBe('правка 007 пошла волной');
    expect(summarize(subject({ kind: 'cascade.closed', chapter: null, payload: { outcome: 'consistent' } }))).toBe(
      'волна правки 007 закончена',
    );
    expect(summarize(subject({ kind: 'cascade.closed', chapter: null, payload: { outcome: 'escalated:budget' } }))).toBe(
      'волна правки 007 остановлена',
    );
    expect(summarize(subject({ kind: 'step.closed', payload: { outcome: 'rewritten' } }))).toBe(
      'глава 9: переписана правкой 007 (Аня)',
    );
    expect(summarize(subject({ kind: 'step.closed', payload: { outcome: 'escalated' } }))).toBe(
      'глава 9: остановлена правкой 007 (Аня)',
    );
    expect(summarize(subject({ kind: 'overwrite', payload: { replacedBy: 'ch09#1' } }))).toBe(
      'в главе 9 абзац переписан правкой 007 (Аня)',
    );
    expect(summarize(subject({ kind: 'overwrite', payload: {} }))).toBe('в главе 9 абзац убран правкой 007 (Аня)');
    expect(summarize(subject({ kind: 'operator.restore', authorKind: 'operator' }))).toBe('оператор восстановил главу 9');
    expect(summarize(subject({ kind: 'chapter.restored' }))).toBe('глава 9 восстановлена из прежней редакции');
    expect(summarize(subject({ kind: 'operator.hide' }))).toBe('оператор скрыл главу 9');
    expect(summarize(subject({ kind: 'operator.release' }))).toBe('оператор снял аренду: глава 9');
    expect(summarize(subject({ kind: 'step.landed' }))).toBe('глава 9 записана правкой 007 (Аня)');
    expect(summarize(subject({ kind: 'step.opened' }))).toBe('шаг главы 9 открыт правкой 007 (Аня)');
  });

  it('states a document’s moved status as one public line, without a role or a finding', () => {
    expect(
      summarize(
        subject({
          kind: 'document.status',
          chapter: null,
          changeSeq: null,
          authorKind: 'writer',
          authorLabel: 'автор',
          payload: { document: 'приказ № 4', surface: 'Приказ № 4', chapters: [12, 19, 34] },
        }),
      ),
    ).toBe('статус документа Приказ № 4 изменён в главах 12, 19, 34');
    expect(
      summarize(
        subject({ kind: 'document.status', chapter: null, payload: { document: 'справка', surface: 'Справка', chapters: [9] } }),
      ),
    ).toBe('статус документа Справка изменён в главе 9');
    // A payload without a surface falls back to the key; junk chapters are dropped.
    expect(
      summarize(
        subject({
          kind: 'document.status',
          chapter: null,
          payload: { document: '  приказ  № 4 ', chapters: [0, 43, 'x'] },
        }),
      ),
    ).toBe('статус документа приказ № 4 изменён');
    expect(
      summarize(
        subject({ kind: 'document.status', chapter: null, payload: { document: 'документ', surface: '  Документ  ', chapters: [9] } }),
      ),
    ).toBe('статус документа Документ изменён в главе 9');
    expect(summarize(subject({ kind: 'document.status', chapter: null, payload: {} }))).toBe('книга');
  });
});

/**
 * The chronicle is a public surface too: a decision line carries the reader's
 * sentence, and an engine code in the payload never becomes one.
 */
describe('an engine code never reaches the chronicle', () => {
  it('replaces the attempt code with the reader’s sentence', () => {
    const html = summarize(
      subject({
        kind: 'change.decided',
        changeSeq: 2,
        payload: { premise: true, status: 'void', outcome: 'dropped', reason: 'модель не ответила: PROVIDER_SHAPE' },
      }),
    );
    expect(html).not.toMatch(/PROVIDER_SHAPE|ENGINE_TIMEOUT/u);
    expect(html).toContain(STOP_REASONS.shape);
  });

  it('keeps a human refusal exactly as written', () => {
    expect(
      summarize(
        subject({
          kind: 'change.decided',
          payload: { status: 'void', outcome: 'dropped', reason: 'не беру: документ не из этой сцены' },
        }),
      ),
    ).toBe('правка 007 не применена: не беру: документ не из этой сцены');
  });
});
