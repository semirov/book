/**
 * BOOK-174 — Gate C's `OFF` is answered by the ladder, not by a bare rejection.
 *
 * Split from `audit.test.ts` (the 500-line gate): the verdict half of Gate C is there, the
 * answer half is here. A `legal`/`illegal-content` filing becomes the harm lock; everything else
 * escalates, and the chain and the report are stored either way.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readCommentRow, toCommentDto } from '../src/comments/repo.ts';
import { runFeedback } from '../src/feedback/cli.ts';
import { bootComments, commentBody, type Harness } from './comments/helpers.ts';
import { longProse } from './helpers.ts';

let harness: Harness | null = null;
let dir: string | null = null;

async function boot(): Promise<Harness> {
  harness = await bootComments({
    chapters: {
      'ch08.md': longProse([
        'Тестовый абзац номер один. Это служебный текст, он не является текстом книги.',
        'Документы лежат в архиве. Это служебный текст.',
      ]),
    },
  });
  dir = mkdtempSync(join(tmpdir(), 'book-audit-gate-c-'));
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = null;
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function cli(h: Harness, ...argv: string[]): { code: number; out: string[] } {
  const out: string[] = [];
  const code = runFeedback(argv, { db: h.db, dir: dir ?? '', now: h.clock.now, print: (line) => out.push(line) });
  return { code, out };
}

async function comment(h: Harness): Promise<string> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: h.headers(),
    payload: commentBody({ body: 'В абзаце дважды «абзац» — оставить одно упоминание.' }),
  });
  expect(response.statusCode).toBe(201);
  return response.json().comment.id;
}

/**
 * Blocker from the review: Gate C's `OFF` was the last writer of a bare rejection. It now goes
 * through the same helper as every other content rejection — a `legal`/`illegal-content` filing
 * becomes the harm lock, everything else escalates — and the chain is stored either way, so the
 * reader's report can be rendered.
 */
describe('Gate C’s OFF is answered by the ladder (BOOK-174)', () => {
  it('records the OFF and stores no chain: the ladder places the reading, not the audit (BOOK-206)', async () => {
    const h = await boot();
    const id = await comment(h);
    expect(cli(h, 'audit', id, '--verdict', 'OFF', '--reason', 'вне книги: этот мир не просит чудес').code).toBe(0);

    const row = readCommentRow(h.db, id)!;
    expect(row).toMatchObject({ status: 'new', disposition: null, lock: null, decided_at: null, audit_verdict: 'OFF' });
    // No report exists before the reading: the DTO says nothing the ladder has not said.
    expect(toCommentDto(h.db, row).report).toBeNull();
    expect(toCommentDto(h.db, row).disposition).toBeNull();
  });
});
