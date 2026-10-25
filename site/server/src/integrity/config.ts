/**
 * The legal denylist and the admin token, read from their files (§13.4, §17).
 *
 * Both are files, never environment values printed into an error: a missing denylist is
 * reported as a problem the panel shows (the gate cannot run, and saying so is the honest
 * answer), while a missing admin token means the admin surface does not exist at all — the
 * process does not invent a credential, and an unconfigured panel must 404, not open.
 */

import { readFileSync } from 'node:fs';

import type { LegalDenylist } from '@book/shared';

export type LoadedDenylist = {
  denylist: LegalDenylist | null;
  /** Why the document is unusable; empty when it parsed. */
  problems: string[];
};

const asList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export function loadDenylist(path: string): LoadedDenylist {
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return { denylist: null, problems: ['legal denylist is missing or not valid JSON — the legal gate cannot run'] };
  }
  return {
    denylist: {
      version: typeof document.version === 'number' ? document.version : 1,
      note: typeof document.note === 'string' ? document.note : undefined,
      persons: asList(document.persons),
      characters: asList(document.characters),
      organisations: asList(document.organisations),
      patterns: asList(document.patterns),
    },
    problems: [],
  };
}

/** The admin token: the inline value (tests) or the file (deployment). Empty = disabled. */
export function readAdminToken(inline: string, file: string): string {
  if (inline.trim().length > 0) return inline.trim();
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}
