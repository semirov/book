import { describe, expect, it } from 'vitest';

import { revisingOf } from './revisingMark.ts';

/**
 * BOOK-DOC-84 — the `block:revising` **frame** was deleted (it had no emitter); the mark's
 * carrier is `state.revising`. The page keeps exactly the prop it always had, built from that
 * one field, so a deleted frame cannot leave a dead branch or an always-empty map behind.
 */
describe('revisingOf', () => {
  it('projects the snapshot’s marks onto the slots, and nothing else', () => {
    const marks = revisingOf([
      {
        chapter: 7,
        blockIds: ['ch07#aa11bb22'],
        cause: 'draft',
        changeId: null,
        since: '2026-10-29T10:00:00Z',
        expiresAt: '2026-10-29T10:05:00Z',
      },
    ]);
    expect(Object.keys(marks)).toEqual(['7']);
    expect(marks[7]).toMatchObject({ n: 7, active: true, blockIds: ['ch07#aa11bb22'], cause: 'draft' });
  });

  it('is an empty map when the snapshot has no marks (the normal state)', () => {
    expect(revisingOf([])).toEqual({});
    expect(revisingOf(undefined)).toEqual({});
  });
});
