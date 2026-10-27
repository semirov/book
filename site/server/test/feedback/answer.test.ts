/**
 * `--answer` — the gate's own object, parsed before anything is recorded (BOOK-61 review B2).
 *
 * The parser in `feedback/gate.ts` had no production caller: `audit` recorded `--verdict FITS`
 * with no envelope and no evidence, so a model's answer and an operator's opinion were the same
 * call. These tests pin the second path: the answer is read against the batch the filing belongs
 * to, a malformed object or a quote that is not in the named field records **nothing**, and a
 * valid answer is the only thing that moves the column.
 *
 * The operator path is untouched, and the two cannot be mixed for one call.
 */

import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readCommentRow } from '../../src/comments/repo.ts';
import { runFeedback } from '../../src/feedback/cli.ts';
import { bootComments, commentBody, type Harness } from '../comments/helpers.ts';

let harness: Harness | null = null;
let dir: string | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function boot(): Promise<Harness> {
  harness = await bootComments();
  dir = mkdtempSync(join(tmpdir(), 'book-answer-'));
  return harness;
}

function cli(...argv: string[]): { code: number; out: string[] } {
  const out: string[] = [];
  const code = runFeedback(argv, {
    db: harness!.db,
    dir: dir ?? '',
    now: harness!.clock.now,
    print: (line) => out.push(line),
  });
  return { code, out };
}

async function comment(body: string, extra: Record<string, unknown> = {}): Promise<string> {
  const response = await harness!.app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: harness!.headers(),
    payload: commentBody({ chapter: 8, body, ...extra }),
  });
  expect(response.statusCode).toBe(201);
  return response.json().comment.id as string;
}

/** The model's answer, as one JSON object — the shape the prompt asks for. */
function answer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    envelope: 'book.verdict/v1',
    itemId: 'cmt_placeholder',
    gate: 'C',
    verdict: 'FITS',
    rule: null,
    evidence: [],
    ...overrides,
  });
}

describe('feedback.mjs audit --answer — the model’s own object', () => {
  it('refuses an answer whose quote is not in the field it names, and records nothing', async () => {
    const h = await boot();
    const id = await comment('В абзаце дважды «слово» — оставить одно упоминание.');
    expect(cli('inbox').code).toBe(0);

    const fabricated = cli(
      'audit',
      id,
      '--answer',
      answer({ itemId: id, evidence: [{ field: 'text', quote: 'такой фразы в заявке нет' }] }),
    );
    expect(fabricated.code).toBe(1);
    expect(fabricated.out.join('\n')).toContain('POSTCHECK_FAILED');
    expect(readCommentRow(h.db, id)?.audit_verdict).toBeNull();

    // A bare token is not an object, and an answer for another row is not this row's.
    expect(cli('audit', id, '--answer', 'FITS').code).toBe(1);
    expect(cli('audit', id, '--answer', answer({ itemId: 'cmt_elsewhere' })).code).toBe(1);
    // `FITS` carries no reason: a sentence there is a malformed answer, not a comment on it.
    expect(cli('audit', id, '--answer', answer({ itemId: id, reason: 'мне нравится' })).code).toBe(1);
    expect(readCommentRow(h.db, id)?.audit_verdict).toBeNull();
  });

  it('records a valid answer, and only a valid one', async () => {
    const h = await boot();
    const id = await comment('В абзаце дважды «слово» — оставить одно упоминание.');
    expect(cli('inbox').code).toBe(0);

    const valid = cli(
      'audit',
      id,
      '--answer',
      answer({ itemId: id, evidence: [{ field: 'text', quote: 'оставить одно упоминание' }] }),
    );
    expect(valid.code).toBe(0);
    expect(valid.out.join('\n')).toContain('FITS');
    expect(readCommentRow(h.db, id)).toMatchObject({ audit_verdict: 'FITS', audit_reason: null });
  });

  it('refuses when the batch file the row names is gone (an answer needs its envelope)', async () => {
    const h = await boot();
    const id = await comment('В абзаце дважды «слово» — оставить одно упоминание.');
    expect(cli('inbox').code).toBe(0);
    const batch = readCommentRow(h.db, id)?.batch_id;
    expect(batch).toBeTruthy();
    unlinkSync(join(dir ?? '', 'batches', `${batch}.jsonl`));

    const result = cli('audit', id, '--answer', answer({ itemId: id }));
    expect(result.code).toBe(1);
    expect(result.out.join('\n')).toContain('NO_BATCH');
    expect(readCommentRow(h.db, id)?.audit_verdict).toBeNull();
  });

  it('cannot be combined with the operator path, and a row outside a batch has no envelope', async () => {
    const h = await boot();
    const id = await comment('В абзаце дважды «слово» — оставить одно упоминание.');
    expect(cli('audit', id, '--answer', answer({ itemId: id }), '--verdict', 'FITS').code).toBe(2);
    expect(cli('audit', id, '--answer', answer({ itemId: id }), '--reason', 'мне нравится').code).toBe(2);

    const unbucketed = cli('audit', id, '--answer', answer({ itemId: id }));
    expect(unbucketed.code).toBe(1);
    expect(unbucketed.out.join('\n')).toContain('NO_BATCH');
    expect(readCommentRow(h.db, id)?.audit_verdict).toBeNull();

    // An answer file that is not there is a refusal, not an empty answer.
    const missing = cli('audit', id, '--answer', '@/nowhere/answer.json');
    expect(missing.code).toBe(1);
    expect(missing.out.join('\n')).toContain('ANSWER_UNREADABLE');
  });
});

describe('feedback.mjs rights --answer — Gate B’s own object', () => {
  it('records a CLEAR, and refuses a refusal whose evidence is not in the filing', async () => {
    const h = await boot();
    // A long proposed text: the scan flags it, so the rights verdict stays open for the gate.
    const proposedText = 'Смотритель принёс акт и положил его на стол. '.repeat(6).trim();
    const id = await comment('Правка к первому абзацу.', { proposedText });
    expect(readCommentRow(h.db, id)?.rights_verdict).toBeNull();
    expect(cli('inbox').code).toBe(0);

    const fabricated = cli(
      'rights',
      id,
      '--answer',
      JSON.stringify({
        envelope: 'book.verdict/v1',
        itemId: id,
        gate: 'B',
        verdict: 'REFUSED',
        rule: 'RIGHTS-QUOTE',
        evidence: [{ field: 'text', quote: 'такой фразы в заявке нет' }],
      }),
    );
    expect(fabricated.code).toBe(1);
    expect(fabricated.out.join('\n')).toContain('POSTCHECK_FAILED');
    expect(readCommentRow(h.db, id)?.rights_verdict).toBeNull();

    const cleared = cli(
      'rights',
      id,
      '--answer',
      JSON.stringify({
        envelope: 'book.verdict/v1',
        itemId: id,
        gate: 'B',
        verdict: 'CLEAR',
        rule: null,
        evidence: [],
      }),
    );
    expect(cleared.code).toBe(0);
    expect(readCommentRow(h.db, id)).toMatchObject({ rights_verdict: 'CLEAR', rights_source: 'model' });
  });

  it('cannot be combined with the operator path', async () => {
    await boot();
    const id = await comment('В абзаце дважды «слово» — оставить одно упоминание.');
    const both = cli('rights', id, '--answer', answer({ itemId: id }), '--verdict', 'CLEAR');
    expect(both.code).toBe(2);
  });
});
