/**
 * One line per triage decision, in the file the site tails (`decisions.jsonl`, ADR-007).
 *
 * It is its own module because two commands write it — `decide` and `audit` — and a second copy
 * of the line's shape would drift from the tailer's parser.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function appendDecision(dir: string, line: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'decisions.jsonl'), `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 });
}
