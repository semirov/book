/**
 * F010 — one book file per commit (ARCHITECTURE.md §13.1, ADR-008).
 *
 * A commit is the writer's step made visible: it carries exactly one chapter (or the first
 * sheet). Everything else is a bulk rewrite and must say so in its first line —
 * `sweep: …` — because a commit that silently touches twenty chapters destroys the answer to
 * «why did chapter 9 change, and did a gate bless it?».
 *
 * This module is the decision, not the plumbing: it takes the staged paths and the commit
 * message and returns findings, so the git hook and the tests agree on one rule.
 */

import type { Finding } from './text.ts';

/** `manuscript/chNN.md` for 01..67, or the first sheet; nothing else is a book file. */
const BOOK_FILE = /^manuscript\/(?:ch(?:0[1-9]|[1-5][0-9]|6[0-7])\.md|00-front\.md)$/u;

export const SWEEP_PREFIX = 'sweep:';

export function isBookFile(path: string): boolean {
  return BOOK_FILE.test(path);
}

/** The book files of a commit, in the order git printed them (stable for a message). */
export function stagedBookFiles(staged: readonly string[]): string[] {
  return staged.filter(isBookFile);
}

/** The subject line decides: a `sweep:` commit may touch the whole book, nothing else may. */
export function commitSubject(message: string): string {
  for (const line of message.split('\n')) {
    const subject = line.trim();
    if (subject.length > 0) return subject;
  }
  return '';
}

export function isSweep(message: string): boolean {
  return commitSubject(message).toLowerCase().startsWith(SWEEP_PREFIX);
}

/**
 * F010: more than one book file in a commit is an error unless the subject starts with
 * `sweep:`. Non-book paths are free — a step may edit the site, the notes or a test.
 */
export function checkCommitScope(staged: readonly string[], message: string): Finding[] {
  const bookFiles = stagedBookFiles(staged);
  if (bookFiles.length <= 1 || isSweep(message)) return [];
  return [
    {
      rule: 'F010',
      severity: 'error',
      file: bookFiles[0] ?? 'manuscript/',
      line: 1,
      message:
        `commit touches ${bookFiles.length} book files (${bookFiles.join(', ')}); ` +
        `one step writes one file — split the commit, or start the subject with «${SWEEP_PREFIX}»`,
    },
  ];
}
