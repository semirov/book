/**
 * BOOK-158 — what an answer costs, and what it does not.
 *
 * Every submission a model may judge is an attempt (`comments/attempts.ts`); the answer closes
 * it (`accepted`/`refused`/`held`) and, when a model read it, charges a `triage` pass to the
 * same money ledger the writer lane closes into. A refusal still writes its row: the call was
 * paid whether or not the words were taken, and a ledger that hid refusals would understate the
 * day it has to bound.
 *
 * The daily edit is a different budget with a different rule (BOOK-DOC-4 rule 5): **acceptance**
 * spends it, for a note and an intervention alike, a refusal spends nothing, and an exempt
 * identity (BOOK-113) spends nothing at all.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readBookCost } from '../../src/cost/book.ts';
import { runFeedback } from '../../src/feedback/cli.ts';
import { DECISION_FALLBACK, publicDecisionReason } from '../../src/feedback/decisions.ts';
import { chargeTriageSpend } from '../../src/feedback/triage.ts';
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
  dir = mkdtempSync(join(tmpdir(), 'book-triage-'));
  return harness;
}

function cli(h: Harness, ...argv: string[]): { code: number; out: string[] } {
  const out: string[] = [];
  const code = runFeedback(argv, { db: h.db, dir: dir ?? '', now: h.clock.now, print: (line) => out.push(line) });
  return { code, out };
}

async function filing(h: Harness, body: string): Promise<string> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: h.headers(),
    payload: commentBody({ body }),
  });
  expect(response.statusCode).toBe(201);
  return response.json().comment.id as string;
}

function spend(h: Harness): Array<Record<string, unknown>> {
  return h.db.prepare('SELECT * FROM pass_spend ORDER BY id').all() as Array<Record<string, unknown>>;
}

function attempt(h: Harness, id: string): { n: number; outcome: string | null; decided_at: string | null } {
  return h.db
    .prepare('SELECT n, outcome, decided_at FROM comment_attempts WHERE comment_id = ? ORDER BY n DESC LIMIT 1')
    .get(id) as { n: number; outcome: string | null; decided_at: string | null };
}

function editKeys(h: Harness): string[] {
  return (
    h.db.prepare(`SELECT key FROM rate_events WHERE key LIKE 'edit:%' ORDER BY key`).all() as Array<{ key: string }>
  ).map((row) => row.key);
}

const REJECT = ['--reason', 'вне рамок: не про текст этой главы'];

describe('the ledger records the spend of a refused attempt', () => {
  it('charges a triage pass and closes the attempt as refused under a lock', async () => {
    const h = await boot();
    const id = await filing(h, 'В абзаце дважды «абзац» — оставить одно упоминание.');
    // BOOK-206: the one refusal left is a lock — the legal flag is the harm lock's fact.
    h.db.prepare(`UPDATE comments SET guard = 'legal' WHERE id = ?`).run(id);

    const rejected = cli(
      h,
      'decide',
      id,
      'rejected',
      ...REJECT,
      '--model',
      'deepseek/deepseek-v4-pro',
      '--tokens-in',
      '120',
      '--tokens-out',
      '30',
      '--usd',
      '0.02',
    );
    expect(rejected.code).toBe(0);

    const rows = spend(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pass: 'triage',
      pass_id: `triage:${id}:1`,
      chapter: 8,
      model: 'deepseek/deepseek-v4-pro',
      tokens_in: 120,
      tokens_out: 30,
      usd: 0.02,
      priced: 1,
      day: '2026-10-25',
    });
    // The lock refused the filing, so the ledger says `refused`.
    expect(attempt(h, id)).toMatchObject({ n: 1, outcome: 'refused' });
    // The answer cost the reader no edit: the day belongs to an accepted filing.
    expect(editKeys(h)).toEqual([]);

    // A retried call is refused before it can charge the same attempt twice: first decision wins.
    expect(cli(h, 'decide', id, 'rejected', ...REJECT).code).toBe(1);
    expect(spend(h)).toHaveLength(1);
  });

  it('charges the auditor’s OFF the same way', async () => {
    const h = await boot();
    const id = await filing(h, 'В абзаце дважды «абзац» — оставить одно упоминание.');

    const off = cli(
      h,
      'audit',
      id,
      '--verdict',
      'OFF',
      '--reason',
      'вне книги: этот мир не просит чудес',
      '--model',
      'deepseek/deepseek-v4-pro',
      '--tokens-in',
      '40',
      '--tokens-out',
      '8',
      '--usd',
      '0.001',
    );
    expect(off.code).toBe(0);
    expect(spend(h)).toHaveLength(1);
    expect(spend(h)[0]).toMatchObject({ pass: 'triage', pass_id: `triage:${id}:1`, usd: 0.001, priced: 1 });
    // BOOK-206: the attempt stays open — the applier still has to place the reading it carries.
    expect(attempt(h, id)).toMatchObject({ outcome: 'submitted', decided_at: null });
  });

  it('writes no row when no amount was named, and keeps the attempt closed', async () => {
    const h = await boot();
    const id = await filing(h, 'В абзаце дважды «абзац» — оставить одно упоминание.');
    h.db.prepare(`UPDATE comments SET guard = 'legal' WHERE id = ?`).run(id);
    expect(cli(h, 'decide', id, 'rejected', ...REJECT).code).toBe(0);
    expect(spend(h)).toHaveLength(1);
    expect(spend(h)[0]).toMatchObject({ model: null, tokens_in: 0, tokens_out: 0, usd: 0, priced: 0 });
    expect(attempt(h, id)).toMatchObject({ outcome: 'refused' });
  });

  it('refuses a value that is not money instead of guessing one', async () => {
    const h = await boot();
    const id = await filing(h, 'В абзаце дважды «абзац» — оставить одно упоминание.');
    const bad = cli(h, 'decide', id, 'rejected', ...REJECT, '--usd', 'дешево');
    expect(bad.code).toBe(2);
    // Nothing was decided and nothing was charged.
    expect(h.db.prepare('SELECT status, decided_at FROM comments WHERE id = ?').get(id)).toEqual({
      status: 'new',
      decided_at: null,
    });
    expect(spend(h)).toEqual([]);
    expect(attempt(h, id)).toMatchObject({ outcome: 'submitted' });
  });
});

describe('the refusal the reader reads is always a sentence', () => {
  it('keeps an engine handle on the operator’s column and prints nothing to the reader', async () => {
    const h = await boot();
    const id = await filing(h, 'В абзаце дважды «абзац» — оставить одно упоминание.');
    expect(cli(h, 'audit', id, '--verdict', 'OFF', '--reason', 'INTENT_SHAPE').code).toBe(0);

    // BOOK-206: an `OFF` records the verdict and leaves the row — the reader's line is the
    // ladder's, written when the applier places the reading, never this handle.
    expect(h.db.prepare('SELECT status, reason, audit_reason FROM comments WHERE id = ?').get(id)).toEqual({
      status: 'new',
      reason: null,
      audit_reason: 'INTENT_SHAPE',
    });
  });

  it('does the same for a decision line that carries a handle', () => {
    expect(publicDecisionReason('PROVIDER_SHAPE')).toBe(DECISION_FALLBACK);
    expect(publicDecisionReason('вне рамок: не про текст')).toBe('вне рамок: не про текст');
    expect(publicDecisionReason('')).toBe(DECISION_FALLBACK);
    // A sentence with capitals and no underscore is a sentence, not a handle.
    expect(publicDecisionReason('глава 65 не готова')).toBe('глава 65 не готова');
  });
});

describe('a refusal does not spend the daily edit budget, an accepted filing does', () => {
  async function accept(h: Harness, id: string): Promise<number> {
    expect(cli(h, 'audit', id, '--verdict', 'FITS').code).toBe(0);
    return cli(
      h,
      'decide',
      id,
      'accepted',
      '--reason',
      'сократить второй абзац',
      '--intent',
      'сократить второй абзац до одного предложения',
    ).code;
  }

  it('spends on acceptance only, once a day, and never for an exempt identity', async () => {
    const h = await boot();
    const refusedId = await filing(h, 'Первый абзац лучше начать иначе.');
    h.db.prepare(`UPDATE comments SET guard = 'legal' WHERE id = ?`).run(refusedId);
    expect(cli(h, 'decide', refusedId, 'rejected', ...REJECT).code).toBe(0);
    expect(editKeys(h)).toEqual([]);

    const first = await filing(h, 'Второй абзац тоже стоит сократить.');
    expect(await accept(h, first)).toBe(0);
    expect(editKeys(h)).toHaveLength(2);
    // Both keys belong to the one accepted filing, and the attempt is closed with it.
    expect(attempt(h, first)).toMatchObject({ n: 1, outcome: 'accepted' });

    // The day is spent: the next accepted filing is refused before a change exists.
    const second = await filing(h, 'Третий абзац тоже длинный.');
    const refused = cli(
      h,
      'decide',
      second,
      'accepted',
      '--reason',
      'сократить третий абзац',
      '--intent',
      'сократить третий абзац до одного предложения',
    );
    expect(refused.code).toBe(1);
    expect(refused.out.join('\n')).toContain('EDIT_DAILY_LIMIT');
    expect(editKeys(h)).toHaveLength(2);
    expect(attempt(h, second)).toMatchObject({ outcome: 'submitted' });

    // BOOK-113: an exempt identity's acceptance spends nothing at all.
    h.db.prepare('UPDATE identities SET edit_exempt = 1 WHERE id = ?').run(h.identity.id);
    const exempted = await filing(h, 'Четвёртый абзац стоит сократить.');
    expect(await accept(h, exempted)).toBe(0);
    expect(editKeys(h)).toHaveLength(2);
    expect(attempt(h, exempted)).toMatchObject({ outcome: 'accepted' });
  });
});

describe('an estimated triage call is priced and named (BOOK-219)', () => {
  it('writes `pipeline-estimated` even when the estimate is zero, and stays silent otherwise', async () => {
    const h = await boot();
    chargeTriageSpend(h.db, {
      chapter: 8,
      passId: 'triage:cmt_estimated:1',
      at: '2026-10-25T10:00:00.000Z',
      model: 'deepseek/deepseek-v4-pro',
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
      estimated: true,
    });
    // The rate is known and only the counts were read: priced, and the row says how.
    expect(spend(h)[0]).toMatchObject({ usd: 0, priced: 1, provenance: 'pipeline-estimated' });

    // A measured zero stays BOOK-23's honest «never priced», and a caller that does not know who
    // ran the pass declares no provenance rather than inventing one.
    chargeTriageSpend(h.db, {
      chapter: 8,
      passId: 'triage:cmt_measured:1',
      at: '2026-10-25T10:00:01.000Z',
      model: null,
      tokensIn: 0,
      tokensOut: 0,
      usd: 0,
    });
    expect(spend(h)[1]).toMatchObject({ usd: 0, priced: 0, provenance: null });
  });
});

describe('the footer’s aggregate counts triage money, not triage steps (BOOK-158 review m4)', () => {
  it('keeps a model-less triage row out of the null-model step group', async () => {
    const h = await boot();
    // One writer pass that really wrote prose: the only `steps` row in the book.
    h.db
      .prepare(
        `INSERT INTO pass_spend (at, day, pass_id, chapter, pass, change_id, model, tokens_in, tokens_out, usd, priced)
         VALUES ('2026-10-25T10:00:00Z', '2026-10-25', 'stp_a', 8, 'draft', NULL, 'deepseek-flash', 1000000, 0, 0.15, 1)`,
      )
      .run();

    // A lock refusal with no model: the ledger row has no model and no amount.
    const id = await filing(h, 'В абзаце дважды «абзац» — оставить одно упоминание.');
    h.db.prepare(`UPDATE comments SET guard = 'legal' WHERE id = ?`).run(id);
    expect(cli(h, 'decide', id, 'rejected', ...REJECT).code).toBe(0);
    expect(spend(h)).toHaveLength(2);

    const cost = readBookCost(h.db);
    // The triage pass is money (zero here) but not a writing step: `model IS NULL` stays empty.
    expect(cost.steps).toBe(1);
    expect(cost.tokens).toBe(1_000_000);
    expect(cost.usd).toBe(0.15);
    expect(cost.unpriced).toEqual([]);
  });

  it('still adds a priced triage pass to the total without counting it as a step', async () => {
    const h = await boot();
    const id = await filing(h, 'В абзаце дважды «абзац» — оставить одно упоминание.');
    h.db.prepare(`UPDATE comments SET guard = 'legal' WHERE id = ?`).run(id);
    expect(
      cli(
        h,
        'decide',
        id,
        'rejected',
        ...REJECT,
        '--model',
        'deepseek/deepseek-v4-pro',
        '--tokens-in',
        '1000',
        '--tokens-out',
        '200',
        '--usd',
        '0.02',
      ).code,
    ).toBe(0);

    const cost = readBookCost(h.db);
    expect(cost.steps).toBe(0);
    expect(cost.tokens).toBe(1_200);
    expect(cost.usd).toBe(0.02);
  });
});
