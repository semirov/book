import { describe, expect, it } from 'vitest';

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
    expect(summarize(subject())).toBe('глава 9 изменена правкой 7 (Аня)');
    expect(summarize(subject({ payload: { kind: 'rewrite' } }))).toBe('глава 9 переписана правкой 7 (Аня)');
    expect(summarize(subject({ kind: 'chapter.created', changeSeq: null }))).toBe('глава 9 написана');
  });

  it('says «правка вне процесса» when no lease owned the write', () => {
    expect(summarize(subject({ changeSeq: null, authorKind: 'unattributed' }))).toBe(
      'глава 9 изменена — правка вне процесса',
    );
  });

  it('describes the first sheet without pretending it is a chapter', () => {
    expect(summarize(subject({ isFront: true, chapter: null, kind: 'front.revised', payload: { changed: { title: true } } }))).toBe(
      'название изменилось правкой 7 (Аня)',
    );
    expect(
      summarize(
        subject({
          isFront: true,
          chapter: null,
          kind: 'front.revised',
          payload: { changed: { title: true, about: true } },
        }),
      ),
    ).toBe('название и «о чём эта книга» изменены правкой 7 (Аня)');
  });

  it('never repeats a gate finding: a verdict is only «замечание сохранено»', () => {
    const line = summarize(
      subject({ kind: 'gate.recorded', payload: { role: 'consultant', findings: 'секрет редактора' } }),
    );
    expect(line).toBe('глава 9: замечание сохранено (научный консультант)');
    expect(line).not.toContain('секрет');
  });

  it('shows a dropped change with its public reason', () => {
    expect(
      summarize(subject({ kind: 'change.decided', chapter: null, payload: { status: 'void', outcome: 'dropped', reason: 'основа изменилась' } })),
    ).toBe('правка 7 не применена: основа изменилась');
    expect(summarize(subject({ kind: 'change.decided', chapter: null, payload: { status: 'done', outcome: 'applied' } }))).toBe(
      'правка 7 внесена',
    );
    expect(
      summarize(subject({ kind: 'change.decided', chapter: null, payload: { status: 'escalated', outcome: 'origin' } })),
    ).toBe('правка 7 требует решения');
  });

  it('covers the queue, the ripple and the operator facts', () => {
    expect(summarize(subject({ kind: 'change.queued', chapter: null }))).toBe('правка 7 встала в очередь');
    expect(summarize(subject({ kind: 'change.processing', chapter: null }))).toBe('правка 7 в работе');
    expect(summarize(subject({ kind: 'change.stale', chapter: null }))).toBe('правка 7: основа изменилась');
    expect(summarize(subject({ kind: 'cascade.opened', chapter: null }))).toBe('правка 7 пошла волной');
    expect(summarize(subject({ kind: 'cascade.closed', chapter: null, payload: { outcome: 'consistent' } }))).toBe(
      'волна правки 7 закончена',
    );
    expect(summarize(subject({ kind: 'cascade.closed', chapter: null, payload: { outcome: 'escalated:budget' } }))).toBe(
      'волна правки 7 остановлена',
    );
    expect(summarize(subject({ kind: 'step.closed', payload: { outcome: 'rewritten' } }))).toBe(
      'глава 9: переписана правкой 7 (Аня)',
    );
    expect(summarize(subject({ kind: 'step.closed', payload: { outcome: 'escalated' } }))).toBe(
      'глава 9: остановлена правкой 7 (Аня)',
    );
    expect(summarize(subject({ kind: 'overwrite', payload: { replacedBy: 'ch09#1' } }))).toBe(
      'в главе 9 абзац переписан правкой 7 (Аня)',
    );
    expect(summarize(subject({ kind: 'overwrite', payload: {} }))).toBe('в главе 9 абзац убран правкой 7 (Аня)');
    expect(summarize(subject({ kind: 'operator.restore', authorKind: 'operator' }))).toBe('оператор восстановил главу 9');
    expect(summarize(subject({ kind: 'chapter.restored' }))).toBe('глава 9 восстановлена из прежней ревизии');
    expect(summarize(subject({ kind: 'operator.hide' }))).toBe('оператор скрыл главу 9');
    expect(summarize(subject({ kind: 'operator.release' }))).toBe('оператор снял аренду: глава 9');
    expect(summarize(subject({ kind: 'step.landed' }))).toBe('глава 9 записана правкой 7 (Аня)');
    expect(summarize(subject({ kind: 'step.opened' }))).toBe('шаг главы 9 открыт правкой 7 (Аня)');
  });
});
