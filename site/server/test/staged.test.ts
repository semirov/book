import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { readStagedCommit } from '../../bin/lib/staged.ts';
import { createFixture } from './helpers.ts';

/** A fake git: the index listing, the blob contents and the message file. */
function fakeGit(fixtureRoot: string, options: { staged: string[]; blobs: Record<string, string>; message: string }) {
  const gitDir = join(fixtureRoot, '.git');
  mkdirSync(gitDir, { recursive: true });
  // A real directory is enough for `rev-parse --absolute-git-dir`; the reader only joins.
  return vi.fn((args: string[]) => {
    if (args[0] === 'diff') return options.staged.join('\u0000') + '\u0000';
    if (args[0] === 'show') {
      const path = args[1]?.slice(1) ?? '';
      const blob = options.blobs[path];
      if (blob === undefined) throw new Error(`no blob for ${path}`);
      return blob;
    }
    if (args[0] === 'rev-parse') {
      writeFileSync(join(gitDir, 'COMMIT_EDITMSG'), options.message, 'utf8');
      return `${gitDir}\n`;
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  });
}

describe('the staged view of a commit (§13.1)', () => {
  it('reads book files from the index, not from the working tree', () => {
    const fixture = createFixture();
    try {
      fixture.write('ch09.md', 'working tree version, not staged');
      const run = fakeGit(fixture.root, {
        staged: ['manuscript/ch09.md', 'site/README.md'],
        blobs: { 'manuscript/ch09.md': 'Глава 9\n\nИндексная версия абзаца.' },
        message: 'draft fwd: ch09 written\n',
      });

      const staged = readStagedCommit(fixture.root, run);
      expect(staged.staged).toEqual(['manuscript/ch09.md', 'site/README.md']);
      expect(staged.files).toEqual([{ name: 'ch09.md', text: 'Глава 9\n\nИндексная версия абзаца.' }]);
      expect(staged.message).toBe('draft fwd: ch09 written\n');
    } finally {
      fixture.close();
    }
  });

  it('ignores everything outside the manuscript and survives a missing message file', () => {
    const fixture = createFixture();
    try {
      const run = vi.fn((args: string[]) => {
        if (args[0] === 'diff') return 'site/server/src/app.ts\u0000bible/dossiers.md\u0000';
        if (args[0] === 'rev-parse') return '/nonexistent/git-dir\n';
        throw new Error('the reader must not fetch a blob outside the manuscript');
      });
      const staged = readStagedCommit(fixture.root, run);
      expect(staged.files).toEqual([]);
      expect(staged.message).toBe('');
    } finally {
      fixture.close();
    }
  });

  it('treats a failing git as a failure, not as an empty commit', () => {
    const fixture = createFixture();
    try {
      const run = vi.fn(() => {
        throw new Error('fatal: not a git repository');
      });
      expect(() => readStagedCommit(fixture.root, run)).toThrowError(/not a git repository/u);
    } finally {
      fixture.close();
    }
  });
});
