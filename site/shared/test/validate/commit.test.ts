import { describe, expect, it } from 'vitest';

import {
  checkCommitScope,
  commitSubject,
  isBookFile,
  isSweep,
  stagedBookFiles,
} from '../../src/validate/commit.ts';

describe('F010 — one book file per commit (§13.1)', () => {
  it('recognises a chapter file and the first sheet, and nothing else', () => {
    for (const path of ['manuscript/ch01.md', 'manuscript/ch67.md', 'manuscript/00-front.md']) {
      expect(isBookFile(path)).toBe(true);
    }
    for (const path of [
      'manuscript/ch00.md',
      'manuscript/ch68.md',
      'manuscript/ch1.md',
      'manuscript/notes.md',
      'manuscript/archive/ch01.md',
      'bible/dossiers.md',
      'site/README.md',
    ]) {
      expect(isBookFile(path)).toBe(false);
    }
    expect(stagedBookFiles(['manuscript/ch02.md', 'site/x.ts', 'bible/dossiers.md'])).toEqual(['manuscript/ch02.md']);
  });

  it('accepts a step: one chapter plus the dossiers append', () => {
    expect(checkCommitScope(['manuscript/ch09.md', 'bible/dossiers.md'], 'cascade csc_01/2 fwd: ch09 rewritten')).toEqual(
      [],
    );
  });

  it('accepts a commit that touches no book file at all', () => {
    expect(checkCommitScope(['site/server/src/app.ts', 'website/notes.md'], 'feat(site): panel')).toEqual([]);
  });

  it('refuses two book files without a sweep subject', () => {
    const findings = checkCommitScope(
      ['manuscript/ch09.md', 'manuscript/ch10.md'],
      'cascade csc_01/2 fwd: ch09 and ch10 rewritten',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'F010', severity: 'error', file: 'manuscript/ch09.md', line: 1 });
    expect(findings[0]?.message).toContain('manuscript/ch10.md');
  });

  it('refuses a chapter and the first sheet in one commit', () => {
    expect(checkCommitScope(['manuscript/00-front.md', 'manuscript/ch01.md'], 'front: title')).toHaveLength(1);
  });

  it('allows a bulk rewrite only with a `sweep:` subject, in any case, on the first line', () => {
    const staged = ['manuscript/ch01.md', 'manuscript/ch02.md', 'manuscript/ch03.md'];
    expect(checkCommitScope(staged, 'sweep: retitle every chapter')).toEqual([]);
    expect(checkCommitScope(staged, 'Sweep: retitle every chapter')).toEqual([]);
    expect(checkCommitScope(staged, '\n\nsweep: retitle every chapter\n\nbody')).toEqual([]);
    // The prefix is a promise about the *subject*; a body line does not count.
    expect(checkCommitScope(staged, 'chore: tidy\n\nsweep: not this')).toHaveLength(1);
  });

  it('reads the subject as the first non-empty line', () => {
    expect(commitSubject('\n\ndraft fwd: ch01 written\n\nbody')).toBe('draft fwd: ch01 written');
    expect(commitSubject('')).toBe('');
    expect(isSweep('')).toBe(false);
  });
});
