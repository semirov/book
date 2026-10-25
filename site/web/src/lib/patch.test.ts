import type { BlockDto, PatchOp } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { applyPatch, revisedBlockIds } from './patch.ts';

function block(id: string, text: string): BlockDto {
  return { id, i: 0, text, hash: id.slice(id.indexOf('#') + 1) };
}

const A = block('ch01#aaaaaaa1', 'Первый');
const B = block('ch01#bbbbbbb2', 'Второй');
const C = block('ch01#ccccccc3', 'Третий');

describe('applyPatch', () => {
  it('applies an insert at the end', () => {
    const ops: PatchOp[] = [{ op: 'insert', id: 'ch01#ddddddd4', i: 2, text: 'Четвёртый' }];
    const next = applyPatch([A, B], ops);
    expect(next?.map((item) => item.text)).toEqual(['Первый', 'Второй', 'Четвёртый']);
    expect(next?.map((item) => item.i)).toEqual([0, 1, 2]);
  });

  it('applies an insert in the middle', () => {
    const ops: PatchOp[] = [{ op: 'insert', id: 'ch01#ddddddd4', i: 1, text: 'Между' }];
    expect(applyPatch([A, B], ops)?.map((item) => item.text)).toEqual(['Первый', 'Между', 'Второй']);
  });

  it('applies a replace without re-typing the neighbours', () => {
    const next = applyPatch([A, B, C], [
      { op: 'replace', id: B.id, i: 1, newId: 'ch01#eeeeeee5', text: 'Второй, иначе' },
    ]);
    expect(next?.map((item) => item.text)).toEqual(['Первый', 'Второй, иначе', 'Третий']);
    expect(next?.[1]?.id).toBe('ch01#eeeeeee5');
  });

  it('applies a remove and compacts the indices', () => {
    const next = applyPatch([A, B, C], [{ op: 'remove', id: B.id, i: 1 }]);
    expect(next?.map((item) => item.id)).toEqual([A.id, C.id]);
    expect(next?.map((item) => item.i)).toEqual([0, 1]);
  });

  it('applies a mixed script in one pass', () => {
    const ops: PatchOp[] = [
      { op: 'remove', id: A.id, i: 0 },
      { op: 'insert', id: 'ch01#ddddddd4', i: 0, text: 'Новый первый' },
      { op: 'replace', id: C.id, i: 2, newId: 'ch01#eeeeeee5', text: 'Новый третий' },
    ];
    const next = applyPatch([A, B, C], ops);
    expect(next?.map((item) => item.text)).toEqual(['Новый первый', 'Второй', 'Новый третий']);
  });

  it('refuses a script that does not match the loaded blocks (the caller refetches)', () => {
    expect(applyPatch([A, B], [{ op: 'replace', id: 'ch01#ffffffff', i: 0, newId: 'ch01#gggggggg', text: 'x' }])).toBeNull();
    expect(applyPatch([A, B], [{ op: 'remove', id: 'ch01#ffffffff', i: 0 }])).toBeNull();
    expect(applyPatch([A, B], [{ op: 'replace', id: A.id, i: 0, text: 'x' }])).toBeNull();
    expect(applyPatch([A], [{ op: 'insert', id: 'ch01#zzzzzzzz', i: 9, text: 'x' }])).toBeNull();
  });
});

describe('revisedBlockIds', () => {
  it('names inserted and replaced blocks, never removed ones', () => {
    expect(
      revisedBlockIds([
        { op: 'insert', id: 'ch01#aaaaaaaa', i: 0, text: 'x' },
        { op: 'replace', id: 'ch01#bbbbbbbb', i: 1, newId: 'ch01#cccccccc', text: 'y' },
        { op: 'remove', id: 'ch01#dddddddd', i: 2 },
      ]),
    ).toEqual(['ch01#aaaaaaaa', 'ch01#cccccccc']);
  });
});
