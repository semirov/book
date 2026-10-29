import type { ParagraphChainDto, ParagraphVersionDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { BASIS_HAND, FRAME_HAND, PASS_HAND, UNATTRIBUTED_HAND } from './provenance.ts';
import { NO_REWRITES, SENTENCE_LABEL, sentenceBlockFrame, sentenceFacts } from './sentence.ts';

/**
 * BOOK-128 comment #3815 — «откуда эта фраза» is three facts, in the same register as the word's
 * record: the hand with its moment, whether the phrase can still change, and its trail.
 */

function version(overrides: Partial<ParagraphVersionDto> = {}): ParagraphVersionDto {
  return {
    blockUid: 'blk_1',
    ver: 1,
    blockId: 'ch08#aa11bb22',
    chapter: 8,
    rev: 3,
    at: '2026-10-28T09:08:00Z',
    op: 'revised',
    textHash: 'aa11bb22',
    chars: 120,
    changeId: 'chg_12',
    changeSeq: 12,
    stepId: 'stp_12',
    actor: { kind: 'writer', identityId: null, label: 'автор' },
    replacedBy: null,
    ...overrides,
  };
}

function chain(versions: ParagraphVersionDto[], alive = true): ParagraphChainDto {
  return { blockUid: 'blk_1', blockId: 'ch08#aa11bb22', chapter: 8, alive, line: '', versions };
}

const PASS = sentenceFacts({
  chain: chain([version({ op: 'introduced', changeSeq: null, actor: { kind: 'writer', identityId: null, label: 'автор' }, at: '2026-10-20T09:00:00Z' })]),
  frame: 'none',
});
const REVISED = sentenceFacts({ chain: chain([version()]), frame: 'none' });

describe('the phrase’s three facts', () => {
  it('a pass wrote it: hand and moment, mutating, and the change that landed', () => {
    expect(REVISED.hand).toBe('машина');
    expect(REVISED.mutable).toBe('меняется');
    expect(REVISED.trail).toBe('правка №12 · внесена 12:08');
  });

  it('an introduced block has no change behind it: «правок не было»', () => {
    // The introduction is still a version with a moment: the hand keeps it, only the trail
    // says that no change has landed since.
    expect(PASS.hand).toBe('машина');
    expect(PASS.trail).toBe(NO_REWRITES);
    expect(PASS.trail).toBe('правок не было');
  });

  it('a reader’s filing produced the version: the record’s number stands for the hand', () => {
    const facts = sentenceFacts({
      chain: chain([version({ actor: { kind: 'reader', identityId: 'idt_1', label: 'Аня' }, changeSeq: 12 })]),
      frame: 'none',
    });
    expect(facts.hand).toBe('правка · №12');
    expect(facts.trail).toBe('правка №12 · внесена 12:08');
  });

  it('a reader’s version with no change behind it keeps their name, never the pass', () => {
    // The log numbers no change here, so there is no «правка · №…» to print — but the hand is
    // still the reader's: `машина` would credit the shift with a reader's sentence, which is
    // the one thing `provenance.ts` `handOf` refuses to do for a word.
    const facts = sentenceFacts({
      chain: chain([
        version({ actor: { kind: 'reader', identityId: 'idt_1', label: 'Аня' }, changeSeq: null, changeId: null }),
      ]),
      frame: 'none',
    });
    expect(facts.hand).toBe('Аня');
    expect(facts.hand).not.toContain(PASS_HAND);
    expect(facts.trail).toBe(NO_REWRITES);
  });

  it('the canon sentence: «рамка книги», fixed, and its filing when one stands', () => {
    const facts = sentenceFacts({ chain: chain([version()]), frame: 'frame' });
    expect(facts.hand).toBe(FRAME_HAND);
    expect(facts.mutable).toBe('не меняется');
    expect(facts.trail).toBe('правка №12 · внесена 12:08');
  });

  it('page 2: «основание книги», fixed', () => {
    const facts = sentenceFacts({ chain: null, frame: 'basis' });
    expect(facts.hand).toBe(BASIS_HAND);
    expect(facts.mutable).toBe('не меняется');
    expect(facts.trail).toBe(NO_REWRITES);
  });

  it('a version no actor and no change claims says «правка вне процесса»', () => {
    const facts = sentenceFacts({
      chain: chain([version({ actor: null, changeSeq: null, changeId: null })]),
      frame: 'none',
    });
    expect(facts.hand).toBe(UNATTRIBUTED_HAND);
    expect(facts.trail).toBe(NO_REWRITES);
  });

  it('a phrase the log says was removed does not claim to be editable', () => {
    expect(sentenceFacts({ chain: chain([version()], false), frame: 'none' }).mutable).toBe('не меняется');
  });

  it('a moment that cannot be read leaves the hand without one', () => {
    const facts = sentenceFacts({ chain: chain([version({ at: 'not-a-moment' })]), frame: 'none' });
    expect(facts.hand).toBe(PASS_HAND);
    expect(facts.trail).toBe('правка №12 · внесена —');
  });

  it('a 404 is an answer: the pass wrote the chapter, and no change is claimed', () => {
    const facts = sentenceFacts({ chain: null, frame: 'none' });
    expect(facts.hand).toBe(PASS_HAND);
    expect(facts.mutable).toBe('меняется');
    expect(facts.trail).toBe(NO_REWRITES);
  });
});

describe('the place the phrase sits in', () => {
  it('page 2 is the basis before it is ever a touched frame', () => {
    expect(sentenceBlockFrame({ basis: true, touched: true })).toBe('basis');
    expect(sentenceBlockFrame({ basis: false, touched: true })).toBe('frame');
    expect(sentenceBlockFrame({ basis: false, touched: false })).toBe('none');
  });

  it('the visible label is one word, lowercase', () => {
    expect(SENTENCE_LABEL).toBe('фраза');
  });
});

describe('no id, no version index, no uppercase label reaches the facts', () => {
  it('prints neither a block id nor a `ver` number', () => {
    const text = [REVISED.hand, REVISED.mutable, REVISED.trail].join(' ');
    expect(text).not.toContain('ch08#');
    expect(text).not.toMatch(/[0-9a-f]{8}/u);
    expect(text).not.toContain('эта строка');
  });
});
