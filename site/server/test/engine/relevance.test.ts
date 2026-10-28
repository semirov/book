import type { WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  gradeRelevance,
  needsWriterDecision,
  relevanceOutcome,
  withWriterDecision,
  type RelevanceInput,
} from '../../src/engine/relevance.ts';
import { chapterText, createEngineFixture } from './helpers.ts';

const BLOCKS = [
  { id: 'ch01#a', hash: 'a', text: 'Тестовый абзац номер один. Это служебный текст, он не является текстом книги.' },
  { id: 'ch01#b', hash: 'b', text: 'Это служебный текст.' },
];

function input(
  overrides: {
    baseRev?: number;
    baseBlocks?: string[];
    anchor?: RelevanceInput['anchor'];
    current?: { rev?: number; blocks?: Array<{ id: string; hash: string; text: string }>; text?: string };
  } = {},
): RelevanceInput {
  return {
    baseRev: overrides.baseRev ?? 3,
    baseBlocks: overrides.baseBlocks ?? ['a', 'b'],
    anchor: overrides.anchor === undefined ? { blockIds: ['ch01#a'], quote: 'Тестовая глава' } : overrides.anchor,
    current: {
      rev: overrides.current?.rev ?? 3,
      blocks: overrides.current?.blocks ?? BLOCKS,
      text: overrides.current?.text ?? BLOCKS.map((block) => block.text).join('\n\n'),
    },
  };
}

describe('gradeRelevance — deterministic evidence (§6A.7)', () => {
  it('fresh: the base did not move', () => {
    const grade = gradeRelevance(input());
    expect(grade).toMatchObject({
      grade: 'fresh',
      revAtRecord: 3,
      revNow: 3,
      anchor: 'intact',
      applies: 'yes',
      overlap: 1,
      chapterRewritten: false,
      decidedBy: 'engine',
    });
  });

  it('rebased: the base moved but the paragraphs survived', () => {
    const grade = gradeRelevance(input({ current: { rev: 4, blocks: BLOCKS, text: '' } }));
    expect(grade.grade).toBe('rebased');
    expect(grade.overlap).toBe(1);
    expect(grade.chapterRewritten).toBe(false);
    expect(grade.decidedBy).toBe('engine');
  });

  it('partial: half the base is gone and the writer must decide', () => {
    const grade = gradeRelevance(
      input({
        current: {
          rev: 5,
          blocks: [BLOCKS[0]!, { id: 'ch01#c', hash: 'c', text: 'Служебная строка.' }],
          text: 'Тестовый абзац номер один. Это служебный текст, он не является текстом книги.\n\nСлужебная строка.',
        },
      }),
    );
    expect(grade.grade).toBe('partial');
    expect(grade.overlap).toBe(0.5);
    expect(grade.applies).toBe('untestable');
    expect(grade.decidedBy).toBeNull();
    expect(needsWriterDecision(grade)).toBe(true);
  });

  it('unknown: the anchor is gone and almost nothing of the base remains', () => {
    const grade = gradeRelevance(
      input({
        current: {
          rev: 9,
          blocks: [{ id: 'ch01#z', hash: 'z', text: 'Совсем другой текст.' }],
          text: 'Совсем другой текст.',
        },
      }),
    );
    expect(grade.grade).toBe('unknown');
    expect(grade.anchor).toBe('gone');
    expect(grade.overlap).toBe(0);
    expect(grade.evidence.join(' ')).toContain('не найден');
  });

  it('finds the paragraph by its quote when the block id changed (anchor moved)', () => {
    const grade = gradeRelevance(
      input({
        anchor: { blockIds: ['ch01#old'], quote: 'Тестовый абзац номер один. Это служебный текст, он не является текстом книги.' },
        current: {
          rev: 4,
          blocks: [{ id: 'ch01#new', hash: 'a', text: 'Тестовый абзац номер один. Это служебный текст, он не является текстом книги.' }, BLOCKS[1]!],
        },
      }),
    );
    expect(grade.anchor).toBe('moved');
    expect(grade.grade).toBe('rebased');
  });

  it('a chapter-level change has no paragraph to lose', () => {
    const grade = gradeRelevance(input({ anchor: null, current: { rev: 4, blocks: BLOCKS, text: '' } }));
    expect(grade.anchor).toBe('moved');
    expect(grade.grade).toBe('rebased');
  });
});

describe('the writer decides, the vocabulary follows (§6A.7)', () => {
  const partial = gradeRelevance(input({ current: { rev: 5, blocks: [BLOCKS[0]!], text: '' } }));

  it('void → the change was accepted and not needed', () => {
    const decided = withWriterDecision(partial, 'void', 'в главе уже одно упоминание');
    expect(decided).toMatchObject({ grade: 'void', applies: 'no', decidedBy: 'writer' });
    expect(relevanceOutcome(decided, 'void')).toBe('superseded');
    expect(needsWriterDecision(decided)).toBe(true);
  });

  it('drop cites what made the change unnecessary', () => {
    const decided = withWriterDecision(partial, 'drop', 'фраза уже убрана правкой 4');
    expect(relevanceOutcome(decided, 'drop')).toBe('dropped');
    expect(() => withWriterDecision(partial, 'drop', '  ')).toThrow(/reason/u);
  });

  it('adapt narrows the intent on the same change row', () => {
    const decided = withWriterDecision(partial, 'adapt', 'абзац сузился до одной фразы');
    expect(relevanceOutcome(decided, 'adapt')).toBe('adapted');
    expect(decided.applies).toBe('partial');
  });

  it('a fresh change is applied without a writer verdict', () => {
    expect(relevanceOutcome(gradeRelevance(input()), null)).toBe('applied');
  });
});

describe('relevance at dequeue — the service records what it saw', () => {
  it('grades against the file and refuses to touch a moved base without a decision', () => {
    const fixture = createEngineFixture({
      chapters: { 1: chapterText('Начало', ['Тестовый абзац.', 'Это служебный текст.']) },
    });
    try {
      const change = fixture.engine.enqueue({
        kind: 'accepted_comment',
        chapter: 1,
        intent: 'заменить четверг на среду во всём абзаце',
        anchor: { blockIds: [], quote: 'Тестовый абзац.', prefix: '', suffix: '' },
      });
      // Someone else rewrote the chapter before its turn came: the base moved.
      fixture.writeChapterBlocks(1, 'Начало', ['Служебная строка.', 'Доска на кирпичах.']);
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      expect(assignment.relevance?.grade).toBe('unknown');
      expect(() => fixture.engine.start(assignment.leaseId)).toThrow(/decide adapt\/drop\/void/u);

      const started = fixture.engine.start(assignment.leaseId, {
        decision: 'drop',
        reason: 'абзаца, о котором шла речь, больше нет',
      });
      expect(started).toMatchObject({ closed: true, outcome: 'dropped' });
      const row = fixture.db.prepare('SELECT status, outcome, reason FROM changes WHERE id = ?').get(change.id) as {
        status: string;
        outcome: string;
        reason: string;
      };
      expect(row.status).toBe('void');
      expect(row.outcome).toBe('dropped');
      expect(row.reason).toContain('больше нет');
    } finally {
      fixture.close();
    }
  });

  it('adapt records the narrowed intent and keeps the original', () => {
    const fixture = createEngineFixture({
      chapters: { 1: chapterText('Начало', ['Тестовый абзац.', 'Это служебный текст.']) },
    });
    try {
      const change = fixture.engine.enqueue({
        kind: 'accepted_comment',
        chapter: 1,
        intent: 'убрать абзац из главы и из разговора',
      });
      fixture.writeChapterBlocks(1, 'Начало', ['Служебная строка.', 'Доска на кирпичах.']);
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      fixture.engine.start(assignment.leaseId, {
        decision: 'adapt',
        reason: 'в главе остался только один абзац',
        intent: 'убрать абзац из оставшегося текста',
      });
      const row = fixture.db
        .prepare('SELECT intent, intent_original, outcome FROM changes WHERE id = ?')
        .get(change.id) as { intent: string; intent_original: string; outcome: string };
      expect(row.intent).toBe('убрать абзац из оставшегося текста');
      expect(row.intent_original).toBe('убрать абзац из главы и из разговора');
      expect(row.outcome).toBe('adapted');
    } finally {
      fixture.close();
    }
  });

  it('refuses an adapted intent over the bound and keeps the stored goal (BOOK-44)', () => {
    const fixture = createEngineFixture({
      chapters: { 1: chapterText('Начало', ['Тестовый абзац.', 'Это служебный текст.']) },
    });
    try {
      const change = fixture.engine.enqueue({
        kind: 'accepted_comment',
        chapter: 1,
        intent: 'убрать абзац из главы и из разговора',
      });
      fixture.writeChapterBlocks(1, 'Начало', ['Служебная строка.', 'Доска на кирпичах.']);
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      const stored = () =>
        fixture.db.prepare('SELECT intent FROM changes WHERE id = ?').get(change.id) as { intent: string };
      const adapt = (intent: string) =>
        fixture.engine.start(assignment.leaseId, {
          decision: 'adapt',
          reason: 'в главе остался только один абзац',
          intent,
        });

      // 201 characters is a paragraph again: refused with the path's own code, never truncated —
      // a shortened goal is a different goal — and the row keeps the intent it had.
      try {
        adapt('я'.repeat(201));
        expect.unreachable('a 201-character adapted intent must be refused');
      } catch (error) {
        expect(error).toMatchObject({ code: 'INVALID_INTENT', status: 422 });
      }
      expect(stored().intent).toBe('убрать абзац из главы и из разговора');

      // The bound itself is accepted, and it is what the next pass receives.
      adapt('я'.repeat(200));
      expect(stored().intent).toBe('я'.repeat(200));
    } finally {
      fixture.close();
    }
  });
});
