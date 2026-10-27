import { describe, expect, it } from 'vitest';

import type { BlockRow } from '../src/db/repo/chapters.ts';
import { patchBlocks, patchSize, PATCH_MAX_BYTES } from '../src/ingest/patchBlocks.ts';

function oldRows(texts: string[]): BlockRow[] {
  return texts.map((text, index) => ({
    id: `ch01#${text}`,
    chapter: 1,
    idx: index,
    text,
    hash: text,
    first_rev: 1,
    last_rev: 1,
  }));
}

function newBlocks(texts: string[]): Array<{ id: string; text: string; hash: string }> {
  return texts.map((text) => ({ id: `ch01#${text}`, text, hash: text }));
}

describe('patchBlocks', () => {
  it('sends nothing when the sequences are identical', () => {
    expect(patchBlocks(oldRows(['a', 'b', 'c']), newBlocks(['a', 'b', 'c']))).toEqual([]);
  });

  it('appends one paragraph as an insert at the new index', () => {
    expect(patchBlocks(oldRows(['a', 'b']), newBlocks(['a', 'b', 'c']))).toEqual([
      { op: 'insert', id: 'ch01#c', i: 2, text: 'c' },
    ]);
  });

  it('replaces a paragraph in place', () => {
    const before = oldRows(['a', 'b', 'c']);
    before[1]!.id = 'ch01#oldb';
    before[1]!.hash = 'oldb';
    const after = newBlocks(['a', 'b2', 'c']);
    expect(patchBlocks(before, after)).toEqual([
      { op: 'replace', id: 'ch01#oldb', i: 1, newId: 'ch01#b2', text: 'b2' },
    ]);
  });

  it('removes a paragraph without advancing the new index', () => {
    expect(patchBlocks(oldRows(['a', 'b', 'c']), newBlocks(['a', 'c']))).toEqual([
      { op: 'remove', id: 'ch01#b', i: 1 },
    ]);
  });

  it('inserts at the beginning', () => {
    expect(patchBlocks(oldRows(['b', 'c']), newBlocks(['a', 'b', 'c']))).toEqual([
      { op: 'insert', id: 'ch01#a', i: 0, text: 'a' },
    ]);
  });

  it('replaces a whole chapter as replace pairs (a rewrite)', () => {
    const ops = patchBlocks(oldRows(['a', 'b']), newBlocks(['x', 'y']));
    expect(ops.map((op) => op.op)).toEqual(['replace', 'replace']);
    expect(ops.map((op) => op.i)).toEqual([0, 1]);
  });

  it('handles a mixed edit script', () => {
    const before = oldRows(['keep1', 'old1', 'keep2', 'old2', 'old3']);
    before[1]!.id = 'ch01#aaaaaaa1';
    before[1]!.hash = 'aaaaaaa1';
    before[3]!.id = 'ch01#aaaaaaa3';
    before[3]!.hash = 'aaaaaaa3';
    before[4]!.id = 'ch01#aaaaaaa4';
    before[4]!.hash = 'aaaaaaa4';
    const after = newBlocks(['keep1', 'new1', 'keep2', 'new2', 'keep3']);
    after[1] = { id: 'ch01#bbbbbbb1', text: 'new1', hash: 'bbbbbbb1' };
    after[3] = { id: 'ch01#bbbbbbb2', text: 'new2', hash: 'bbbbbbb2' };
    after[4] = { id: 'ch01#bbbbbbb3', text: 'keep3', hash: 'bbbbbbb3' };

    const ops = patchBlocks(before, after);
    expect(ops).toEqual([
      { op: 'replace', id: 'ch01#aaaaaaa1', i: 1, newId: 'ch01#bbbbbbb1', text: 'new1' },
      { op: 'replace', id: 'ch01#aaaaaaa3', i: 3, newId: 'ch01#bbbbbbb2', text: 'new2' },
      { op: 'replace', id: 'ch01#aaaaaaa4', i: 4, newId: 'ch01#bbbbbbb3', text: 'keep3' },
    ]);
  });

  it('measures the frame cost and knows the 96 KB cap', () => {
    const ops = patchBlocks(oldRows(['a']), newBlocks(['b']));
    expect(patchSize(ops)).toBeGreaterThan(0);
    expect(PATCH_MAX_BYTES).toBe(98_304);
  });
});
