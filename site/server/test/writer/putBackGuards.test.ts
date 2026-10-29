/**
 * BOOK-219's way back, at its own seams: the three answers `putBack` gives.
 *
 * `passEstimated.test.ts` and `closeAtomic.test.ts` prove the pass uses it; these cases pin the
 * guards the invariant depends on — a resumed step's text is not ours, a chapter somebody else has
 * written since is not ours either, and a chapter that cannot be read is never restored blind.
 * The doors are stubbed here so each guard is asked alone, without a fixture book.
 */

import { describe, expect, it } from 'vitest';

import type { ChapterTextView } from '../../src/engine/text.ts';
import type { EngineClient } from '../../src/writer/client.ts';
import { putBack } from '../../src/writer/putBack.ts';

const CHAPTER = 40;
const LANDED = 'Глава сорок\n\nпервый абзац\n\nвторой абзац\n';
const PRE_SHA = 'a'.repeat(64);
const LANDED_SHA = 'b'.repeat(64);

type Doors = { text: string | null; calls: string[] };

/** The three doors, stubbed: `text` answers the chapter, `restore` and `reconcile` are spies. */
function engineOf(doors: Doors): Pick<EngineClient, 'text' | 'restore' | 'reconcile'> {
  const view: ChapterTextView = {
    n: CHAPTER,
    title: 'Глава сорок',
    exists: doors.text !== null,
    basis: false,
    chars: doors.text?.length ?? 0,
    text: doors.text ?? '',
  };
  return {
    text: async () => {
      doors.calls.push('text');
      if (doors.text === null) throw new Error('the rows could not be read');
      return { chapters: [view] };
    },
    restore: async () => {
      doors.calls.push('restore');
      return { rev: 3, sha: PRE_SHA, previousRev: 2 };
    },
    reconcile: async (_chapter, because) => {
      doors.calls.push(`reconcile:${because}`);
      return {};
    },
  };
}

const base = {
  chapter: CHAPTER,
  started: { rev: 1, sha: PRE_SHA },
  landing: { rev: 2, sha: LANDED_SHA },
  text: LANDED,
  why: 'права отказали',
  log: () => undefined,
};

describe('putBack — three answers, three guards', () => {
  it('never touches a resumed step’s text: it was published before this run', async () => {
    const doors = { text: 'чужой текст', calls: [] as string[] };
    const back = await putBack({ ...base, engine: engineOf(doors), job: { stepId: 'stp_1', landed: true }, landed: true });
    expect(back).toEqual({ kind: 'none' });
    expect(doors.calls).toEqual([]);
  });

  it('has nothing to undo when this run landed nothing', async () => {
    const doors = { text: 'чужой текст', calls: [] as string[] };
    const back = await putBack({ ...base, engine: engineOf(doors), job: { stepId: 'stp_1', landed: false }, landed: false });
    expect(back).toEqual({ kind: 'none' });
    expect(doors.calls).toEqual([]);
  });

  it('says the text stands when there is no revision behind a first write', async () => {
    const doors = { text: base.text.replace('второй', 'второй'), calls: [] as string[] };
    const back = await putBack({
      ...base,
      started: { rev: null, sha: '' },
      engine: engineOf(doors),
      job: { stepId: 'stp_1', landed: false },
      landed: true,
    });
    expect(back).toMatchObject({ kind: 'unverified' });
    // No restore was attempted, because there is nothing to restore to.
    expect(doors.calls).toEqual([]);
  });

  it('leaves a chapter somebody else has written since — that text is not ours to undo', async () => {
    const lines: string[] = [];
    const doors = { text: 'первый абзац\n\nсовсем другой абзац', calls: [] as string[] };
    const back = await putBack({
      ...base,
      engine: engineOf(doors),
      job: { stepId: 'stp_1', landed: false },
      landed: true,
      log: (line) => lines.push(line),
    });
    expect(back).toEqual({ kind: 'none' });
    expect(doors.calls).toEqual(['text']);
    expect(lines.join('\n')).toContain('откат не нужен: глава уже не та');
  });

  it('never restores blind when the chapter cannot be read', async () => {
    const doors = { text: null, calls: [] as string[] };
    const back = await putBack({ ...base, engine: engineOf(doors), job: { stepId: 'stp_1', landed: false }, landed: true });
    expect(back).toMatchObject({ kind: 'unverified' });
    expect(doors.calls).toEqual(['text']);
  });

  it('brings the pre-pass revision back and marks the restore with the reason it was taken', async () => {
    const lines: string[] = [];
    const doors = { text: 'первый абзац\n\nвторой абзац', calls: [] as string[] };
    const back = await putBack({
      ...base,
      engine: engineOf(doors),
      job: { stepId: 'stp_1', landed: false },
      landed: true,
      log: (line) => lines.push(line),
    });
    expect(back).toEqual({ kind: 'reverted' });
    expect(doors.calls).toEqual([
      'text',
      'restore',
      'reconcile:откат прохода stp_1: права отказали, текст возвращён к ревизии 1',
    ]);
    expect(lines.join('\n')).toContain('ревизия 1 возвращена (2 → 3)');
  });
});
