/**
 * The imprint is config, not prose (§6C.6): read once at boot, validated exactly, never
 * writable by the writer, never served from `manuscript/`. A drifting imprint is a legal
 * statement drifting — the same rule as F020, enforced at the moment the site starts.
 */

import { readFileSync } from 'node:fs';

import { imprintProblems, type Imprint } from '@book/shared';

export function loadImprint(path: string): Imprint {
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    // The path stays in the boot log; the reader never sees a stack trace.
    throw new Error('imprint: config/imprint.json is missing or not valid JSON');
  }

  const imprint: Imprint = {
    author: typeof document.author === 'string' ? document.author : '',
    copyright: typeof document.copyright === 'string' ? document.copyright : '',
    publisher: typeof document.publisher === 'string' ? document.publisher : null,
    year: typeof document.year === 'string' ? document.year : 'auto',
  };
  const problems = imprintProblems(imprint);
  if (problems.length > 0) throw new Error(`imprint: ${problems.join('; ')}`);
  return imprint;
}
