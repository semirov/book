/**
 * The staged view of a commit (`validate.mjs --staged`, ARCHITECTURE.md §13.1).
 *
 * The pre-commit hook must judge the commit, not the working tree: a writer session may have
 * `ch09.md` half-written while an earlier version is staged. So every file this returns is
 * read from the index (`git show :path`), and the commit message is read from
 * `COMMIT_EDITMSG` — the message git is about to record, not the one in an editor buffer.
 *
 * The git runner is a parameter, so the parsing is testable without a repository. Node 22.18
 * runs this TypeScript directly (type stripping), so the hook needs no build step; nothing
 * here runs git until the hook does.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The real runner: one `git` call, decoded as UTF-8, with room for a large index listing. */
export type GitRun = (args: string[]) => string;

export function gitRunner(root: string): GitRun {
  return (args) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) as string;
}

const BOOK_PATH = /^manuscript\/.*\.md$/u;

export type StagedCommit = {
  /** Every staged path, in git's order. */
  staged: string[];
  /** The staged manuscript files, named as the manuscript directory names them. */
  files: Array<{ name: string; text: string }>;
  /** `COMMIT_EDITMSG`; empty when the run is not a commit. */
  message: string;
};

export function readStagedCommit(root: string, run: GitRun = gitRunner(root)): StagedCommit {
  const listed = run(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
  const staged = listed.split('\u0000').filter((path) => path.length > 0);
  const bookPaths = staged.filter((path) => BOOK_PATH.test(path));
  const files = bookPaths.map((path) => ({
    // The validator names files the way the manuscript directory does (`ch09.md`).
    name: path.slice('manuscript/'.length),
    text: run(['show', `:${path}`]),
  }));

  let message = '';
  try {
    const gitDir = run(['rev-parse', '--absolute-git-dir']).trim();
    const messagePath = join(gitDir, 'COMMIT_EDITMSG');
    if (existsSync(messagePath)) message = readFileSync(messagePath, 'utf8');
  } catch {
    // A manual run outside a commit has no message yet; F010 then sees an empty subject.
  }
  return { staged, files, message };
}
