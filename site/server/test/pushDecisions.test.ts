import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DecisionsTailer } from '../src/feedback/decisions.ts';
import { runFeedback } from '../src/feedback/cli.ts';
import { bootComments, commentBody, type Harness } from './comments/helpers.ts';
import { longProse } from './helpers.ts';

/**
 * BOOK-189 — a filing refused at triage still has an author, and that author is the one reader
 * the engine can never speak for: a refusal never becomes a change, so no close will ever
 * announce it. The tailer is therefore the refusal's only voice, and this file pins the two
 * halves of that contract:
 *
 *   · a **rejected** line reaches `notify` exactly once, on both paths a running site takes —
 *     the operator's `decide` has already written the row before the line is tailed, and a line
 *     written by anything else still gets applied;
 *   · an **accepted** line does not, because its change will speak when it is decided.
 *
 * The tailer is dumb on purpose: `notify` is a callback, the claim and the quiet rules live in
 * `push/passEvent.ts`, so a second call for the same chapter is a `duplicate` there rather than
 * a second notification here.
 */

let harness: Harness | null = null;
let dir: string | null = null;

async function boot(): Promise<Harness> {
  harness = await bootComments({
    chapters: {
      'ch08.md': longProse([
        'Тестовый абзац номер один. Это служебный текст, он не является текстом книги.',
        'Тестовый абзац номер два. Это служебный текст.',
      ]),
    },
  });
  dir = mkdtempSync(join(tmpdir(), 'book-push-decisions-'));
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

function tailerWith(h: Harness, notified: string[]): DecisionsTailer {
  const tailer = new DecisionsTailer({
    db: h.db,
    dir: dir ?? '',
    emit: () => undefined,
    now: h.clock.now,
    replay: true,
    notify: (commentId) => notified.push(commentId),
  });
  tailer.prime();
  return tailer;
}

describe('a decided filing reaches the push hook', () => {
  it('tells it about a refusal the operator already applied, once', async () => {
    const h = await boot();
    const id = await comment(h);
    // The running site's path: `feedback.mjs decide` writes the row, then the line.
    expect(cli(h, 'decide', id, 'rejected', '--reason', 'вне рамок: не про текст этой главы').code).toBe(0);

    const notified: string[] = [];
    const tailer = tailerWith(h, notified);
    expect(tailer.poll()).toBe(1);
    expect(notified).toEqual([id]);
    // A second poll reads no new line, so the reader is not told twice.
    expect(tailer.poll()).toBe(0);
    expect(notified).toEqual([id]);
  });

  it('tells it about a refusal that exists only as a line', async () => {
    const h = await boot();
    const id = await comment(h);
    const notified: string[] = [];
    const tailer = tailerWith(h, notified);

    mkdirSync(dir ?? '', { recursive: true });
    appendFileSync(
      join(dir ?? '', 'decisions.jsonl'),
      `${JSON.stringify({ id, status: 'rejected', reason: 'вне рамок: не про текст', at: h.clock.now().toISOString() })}\n`,
      'utf8',
    );
    expect(tailer.poll()).toBe(1);
    expect(notified).toEqual([id]);
  });

  it('stays silent for an accepted line: its change speaks when it is decided', async () => {
    const h = await boot();
    const id = await comment(h);
    expect(cli(h, 'audit', id, '--verdict', 'FITS').code).toBe(0);
    expect(
      cli(
        h,
        'decide',
        id,
        'accepted',
        '--reason',
        'оставить одно упоминание',
        '--intent',
        'в абзаце дважды «абзац» — оставить одно',
      ).code,
    ).toBe(0);

    const notified: string[] = [];
    const tailer = tailerWith(h, notified);
    expect(tailer.poll()).toBeGreaterThan(0);
    expect(notified).toEqual([]);
  });
});
