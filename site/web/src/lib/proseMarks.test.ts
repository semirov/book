import type { CommentDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { proseMarks } from './proseMarks.ts';

/**
 * BOOK-90 — the paragraph's marks as data, without React or a DOM.
 *
 * The component only reads this result: which group marks which sentence, which filings the
 * phone strip lists, and the memo key the margin pass watches. The cases here are the ones
 * the page must survive: an exact quote, a landed change whose sentence was rewritten, one
 * sentence claimed by two such anchors, and an unresolved anchor that is not a place.
 */

const BLOCK = 'ch08#aa11bb22';
const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K4Q7',
    chapter: 8,
    anchor: {
      blockId: BLOCK,
      blockIndex: 1,
      quote: 'Её освещал яркий свет.',
      prefix: null,
      suffix: null,
      resolved: true,
    },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: null,
    interventionKind: 'testimony',
    status: 'new',
    premise: false,
    reason: null,
    createdAt: '2026-10-21T12:03:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    refusal: null,
    ...overrides,
  };
}

describe('the marks of a paragraph', () => {
  it('marks the sentence whose own quote the filing cites', () => {
    const marks = proseMarks(TEXT, [comment()], BLOCK);
    expect(marks.marks.get(26)?.all.map((item) => item.id)).toEqual(['cmt_01J9Z8K4Q7']);
    expect(marks.alive.map((item) => item.id)).toEqual(['cmt_01J9Z8K4Q7']);
  });

  it('draws a landed change on the sentence its place points at after the rewrite', () => {
    const anchor = {
      ...comment().anchor,
      prefix: 'Я вошёл в пустую комнату. ',
    };
    const landed = comment({ status: 'applied', applied: { chapter: 8, rev: 4 }, anchor });
    const marks = proseMarks('Я вошёл в пустую комнату. Её освещал тусклый свет.', [landed], BLOCK);
    expect(marks.marks.get(26)?.quote).toBe('Её освещал яркий свет.');
    expect(marks.alive).toEqual([]);
  });

  it('gives one sentence to the alive filing, never to the landed one', () => {
    const text = 'Я вошёл в пустую комнату. Свет был включён до меня и горел всю ночь.';
    const pending = comment({ anchor: { ...comment().anchor, quote: 'Свет был включён' } });
    const landed = comment({
      id: 'cmt_01J9Z8K4Q8',
      status: 'applied',
      applied: { chapter: 8, rev: 4 },
      anchor: { ...comment().anchor, quote: 'горел всю ночь' },
    });
    const marks = proseMarks(text, [landed, pending], BLOCK);
    expect(marks.marks.get(26)?.all.map((item) => item.status)).toEqual(['new']);
    expect(marks.alive.map((item) => item.id)).toEqual(['cmt_01J9Z8K4Q7']);
  });

  it('invents no place for an unresolved anchor, and keeps no mark for another block', () => {
    const anchor = { ...comment().anchor, prefix: 'Я вошёл в пустую комнату. ', resolved: false };
    expect(proseMarks('Я вошёл в пустую комнату. Её освещал тусклый свет.', [comment({ anchor })], BLOCK).marks.size).toBe(0);
    expect(proseMarks(TEXT, [comment({ anchor: { ...comment().anchor, blockId: 'ch08#other' } })], BLOCK).marks.size).toBe(0);
  });

  it('keys the block for the margin pass by id and status', () => {
    expect(proseMarks(TEXT, [comment()], BLOCK).key).toBe('cmt_01J9Z8K4Q7:new');
  });
});
