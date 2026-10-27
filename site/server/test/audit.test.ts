import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runFeedback } from '../src/feedback/cli.ts';
import { acceptComment } from '../src/feedback/accept.ts';
import { recordAudit } from '../src/feedback/audit.ts';
import { DecisionsTailer } from '../src/feedback/decisions.ts';
import { insertComment, readCommentRow } from '../src/comments/repo.ts';
import { bootComments, commentBody, type Harness } from './comments/helpers.ts';
import { longProse } from './helpers.ts';

/**
 * BOOK-9 acceptance: an intervention is judged against the book's canvas **before** triage,
 * the verdict is one immutable row on the comment, and no change exists without a `FITS`.
 * The auditor's brief is canon in `process/ROLE_PROMPTS.md` §0; nothing here restates it —
 * these tests only pin the gate: `FITS` permits, `OFF` refuses, neither is a default.
 */

let harness: Harness | null = null;
let dir: string | null = null;

async function boot(): Promise<Harness> {
  harness = await bootComments({
    chapters: {
      'ch08.md': longProse([
        'Тестовый абзац номер один. Это служебный текст, он не является текстом книги.',
        'Документы лежат в архиве. Это служебный текст.',
        'Тестовый абзац номер два. Это служебный текст.',
      ]),
      'ch67.md': longProse(['Служебный текст для проверки.']),
    },
  });
  dir = mkdtempSync(join(tmpdir(), 'book-audit-'));
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

async function comment(h: Harness, body = 'В абзаце дважды «абзац» — оставить одно упоминание.', chapter = 8): Promise<string> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: h.headers(),
    payload: commentBody({ chapter, body }),
  });
  expect(response.statusCode).toBe(201);
  return response.json().comment.id;
}

function auditRow(h: Harness, id: string): Record<string, unknown> {
  return h.db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as Record<string, unknown>;
}

function seed(h: Harness, id: string, chapter = 8): void {
  insertComment(h.db, {
    id,
    identityId: h.identity.id,
    chapter,
    blockId: null,
    blockIndex: null,
    baseRev: chapter === 67 ? null : 1,
    quote: null,
    prefix: null,
    suffix: null,
    author: 'Аня',
    body: 'Тестовое замечание.',
    proposedText: null,
    interventionKind: null,
    bodySha: 'a'.repeat(64),
    flags: [],
    ipHash: 'f'.repeat(64),
    status: 'new',
    guard: null,
    reason: null,
    createdAt: '2026-10-25T12:01:00Z',
    idemKey: null,
  });
}

describe('feedback.mjs audit — the verdict is data, written once, before triage', () => {
  it('records FITS and lets decide accept the change (the happy path)', async () => {
    const h = await boot();
    const id = await comment(h);
    const inbox = cli(h, 'inbox');
    expect(inbox.code).toBe(0);
    // The triage pass is told, once, that the audit comes before any decision.
    expect(inbox.out.join('\n')).toContain('audit (FITS|OFF)');

    const audited = cli(h, 'audit', id, '--verdict', 'FITS', '--by', 'triage-1');
    expect(audited.code).toBe(0);
    expect(audited.out.join('\n')).toContain('FITS');
    const row = auditRow(h, id);
    expect(row).toMatchObject({
      audit_verdict: 'FITS',
      audit_reason: null,
      audited_by: 'triage-1',
      status: 'batched',
      decided_at: null,
    });
    expect(typeof row.audited_at).toBe('string');

    const decided = cli(
      h,
      'decide',
      id,
      'accepted',
      '--reason',
      'оставить одно упоминание',
      '--intent',
      'в абзаце дважды «слово» — оставить одно упоминание',
    );
    expect(decided.code).toBe(0);
    expect(decided.out.join('\n')).toContain('accepted → chg_');
    const accepted = auditRow(h, id);
    expect(accepted.status).toBe('accepted');
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 1 });
  });

  it('OFF records the verdict and refuses the reader in the same act', async () => {
    const h = await boot();
    const id = await comment(h);
    expect(cli(h, 'inbox').code).toBe(0);

    const reason = 'вне книги: этот мир не просит чудес';
    const audited = cli(h, 'audit', id, '--verdict', 'OFF', '--reason', reason, '--by', 'triage-1');
    expect(audited.code).toBe(0);
    expect(audited.out.join('\n')).toContain('OFF');

    const row = auditRow(h, id);
    expect(row).toMatchObject({
      status: 'rejected',
      reason,
      audit_verdict: 'OFF',
      audit_reason: reason,
      audited_by: 'triage-1',
      change_id: null,
    });
    expect(typeof row.decided_at).toBe('string');

    // Every refusal is a decision line the site tails, exactly like a triage rejection.
    const line = JSON.parse(readFileSync(join(dir ?? '', 'decisions.jsonl'), 'utf8').trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ id, status: 'rejected', reason, changeId: null });

    // No change exists, and the single choke point refuses the comment afterwards.
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });
    const refused = acceptComment(h.db, {
      comment: readCommentRow(h.db, id)!,
      intent: 'в абзаце дважды «слово» — оставить одно',
      at: h.clock.now().toISOString(),
      reason: 'повтор',
    });
    expect(refused).toMatchObject({ code: 'AUDIT_REQUIRED' });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });
  });

  it('decide accepted without an audit is refused before any change or budget', async () => {
    const h = await boot();
    const id = await comment(h);
    expect(cli(h, 'inbox').code).toBe(0);
    const budgetBefore = h.db.prepare('SELECT COUNT(*) AS n FROM rate_events').get();

    const refused = cli(
      h,
      'decide',
      id,
      'accepted',
      '--reason',
      'оставить одно упоминание',
      '--intent',
      'в абзаце дважды «слово» — оставить одно упоминание',
    );
    expect(refused.code).toBe(1);
    expect(refused.out.join('\n')).toContain('AUDIT_REQUIRED');
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM rate_events').get()).toEqual(budgetBefore);
    expect(auditRow(h, id)).toMatchObject({ status: 'batched', decided_at: null });
    expect(() => readFileSync(join(dir ?? '', 'decisions.jsonl'), 'utf8')).toThrow();
  });

  it('a banal but on-canvas intervention is FITS and accepted — banality is never refused in code', async () => {
    const h = await boot();
    const id = await comment(h, 'Добавить свидетельство: в архиве нашлась квитанция за электричество.');
    expect(cli(h, 'inbox').code).toBe(0);

    // No --by: the label is provenance, not a requirement.
    const audited = cli(h, 'audit', id, '--verdict', 'FITS');
    expect(audited.code).toBe(0);
    expect(auditRow(h, id)).toMatchObject({ audit_verdict: 'FITS', audit_reason: null, audited_by: null });

    const decided = cli(
      h,
      'decide',
      id,
      'accepted',
      '--reason',
      'в первом абзаце добавить одну фразу об архиве',
      '--intent',
      'в первом абзаце добавить фразу об архиве',
    );
    expect(decided.code).toBe(0);
    expect(auditRow(h, id)).toMatchObject({ status: 'accepted' });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 1 });
  });

  it('refuses a second verdict on the same comment (first verdict wins)', async () => {
    const h = await boot();
    const id = await comment(h);
    expect(cli(h, 'audit', id, '--verdict', 'FITS').code).toBe(0);

    const second = cli(h, 'audit', id, '--verdict', 'OFF', '--reason', 'передумал');
    expect(second.code).toBe(1);
    expect(second.out.join('\n')).toContain('already has a verdict');
    expect(auditRow(h, id)).toMatchObject({ audit_verdict: 'FITS', audit_reason: null, status: 'new' });

    // A decided comment is not audited after the fact either.
    const other = await comment(h, 'Второй абзац стоит сократить.');
    expect(cli(h, 'decide', other, 'rejected', '--reason', 'не по тексту').code).toBe(0);
    const late = cli(h, 'audit', other, '--verdict', 'FITS');
    expect(late.code).toBe(1);
    expect(late.out.join('\n')).toContain('already decided');
  });

  it('keeps ENDING_FROZEN ahead of the audit gate on chapter 67', async () => {
    const h = await boot();
    // BOOK-7: posting to the frozen frame is refused at the door, so the row is seeded as a
    // pre-existing one; the CLI must still refuse a decision before it asks for an audit.
    const id = 'cmt_01JB7FROZEN0000000000067';
    seed(h, id, 67);
    expect(cli(h, 'audit', id, '--verdict', 'FITS').code).toBe(0);

    const refused = cli(h, 'decide', id, 'accepted', '--reason', 'смягчить финал', '--intent', 'смягчить последний абзац');
    expect(refused.code).toBe(1);
    expect(refused.out.join('\n')).toContain('ENDING_FROZEN');
    expect(refused.out.join('\n')).not.toContain('AUDIT_REQUIRED');
  });

  it('refuses bad input with a message and the right exit code', async () => {
    const h = await boot();
    const id = await comment(h);

    const usage = cli(h, 'audit', id, '--verdict', 'MAYBE');
    expect(usage.code).toBe(2);
    expect(usage.out.join('\n')).toContain('usage: feedback.mjs audit');
    expect(cli(h, 'audit').code).toBe(2);

    expect(cli(h, 'audit', 'cmt_missing', '--verdict', 'FITS').code).toBe(1);

    const noReason = cli(h, 'audit', id, '--verdict', 'OFF');
    expect(noReason.code).toBe(1);
    expect(noReason.out.join('\n')).toContain('OFF needs --reason');

    const emptyReason = cli(h, 'audit', id, '--verdict', 'OFF', '--reason', '   ');
    expect(emptyReason.code).toBe(1);

    const longReason = cli(h, 'audit', id, '--verdict', 'OFF', '--reason', 'я'.repeat(201));
    expect(longReason.code).toBe(1);
    expect(longReason.out.join('\n')).toContain('длиннее');

    const longLabel = cli(h, 'audit', id, '--verdict', 'FITS', '--by', 'x'.repeat(65));
    expect(longLabel.code).toBe(1);
    expect(longLabel.out.join('\n')).toContain('--by');

    // Every refusal above left the comment untouched.
    expect(auditRow(h, id)).toMatchObject({ audit_verdict: null, status: 'new', decided_at: null });
  });

  it('shows the auditor reason on the public comment surface, and no verdict vocabulary', async () => {
    const h = await boot();
    const id = await comment(h);
    const reason = 'вне книги: этот мир не просит чудес';
    expect(cli(h, 'audit', id, '--verdict', 'OFF', '--reason', reason).code).toBe(0);

    const listed = await h.app.inject({ method: 'GET', url: '/api/comments?chapter=8' });
    expect(listed.statusCode).toBe(200);
    const item = (listed.json() as { items: Array<Record<string, unknown>> }).items[0] ?? {};
    expect(item).toMatchObject({ id, status: 'rejected', reason });
    const body = JSON.stringify(listed.json());
    for (const word of ['audit', 'auditVerdict', 'FITS', 'OFF']) expect(body).not.toContain(word);

    const single = await h.app.inject({ method: 'GET', url: `/api/comments/${id}` });
    expect(single.json()).toMatchObject({ status: 'rejected', reason });
    expect(JSON.stringify(single.json())).not.toContain('audit');
  });
});

describe('the site decisions tailer is gated too', () => {
  it('refuses an accepted line for an unaudited comment and queues nothing', async () => {
    const h = await boot();
    const id = await comment(h);
    const emitted: Array<{ type: string; data: unknown }> = [];
    const tailer = new DecisionsTailer({
      db: h.db,
      dir: dir ?? '',
      emit: (type, data) => emitted.push({ type, data }),
      now: h.clock.now,
      replay: true,
    });
    tailer.prime();
    mkdirSync(dir ?? '', { recursive: true });
    appendFileSync(
      join(dir ?? '', 'decisions.jsonl'),
      `${JSON.stringify({
        id,
        status: 'accepted',
        reason: 'оставить одно упоминание',
        intent: 'в абзаце дважды «слово» — оставить одно',
        at: h.clock.now().toISOString(),
        changeId: 'chg_tail2',
        rev: { chapter: 8, rev: 1 },
      })}\n`,
      'utf8',
    );

    expect(tailer.poll()).toBe(1);
    const row = auditRow(h, id);
    expect(row.status).toBe('rejected');
    expect(String(row.reason)).toContain('проверку');
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });
    expect(emitted.map((event) => event.type)).toEqual(['comment:decision']);
    expect(emitted[0]?.data).toMatchObject({ status: 'rejected', changeId: null });
  });
});

describe('recordAudit — the module, not the CLI, is the choke point', () => {
  it('refuses an unknown comment, an already recorded verdict, a decided one and an OFF without a reason', async () => {
    const h = await boot();
    const at = h.clock.now().toISOString();

    expect(recordAudit(h.db, { commentId: 'cmt_missing', verdict: 'FITS', reason: null, by: null, at })).toMatchObject({
      code: 'AUDIT_UNKNOWN_COMMENT',
    });

    seed(h, 'cmt_01JB7AUDIT00000000000000A');
    expect(
      recordAudit(h.db, {
        commentId: 'cmt_01JB7AUDIT00000000000000A',
        verdict: 'OFF',
        reason: null,
        by: null,
        at,
      }),
    ).toMatchObject({ code: 'AUDIT_REASON_REQUIRED' });
    expect(
      recordAudit(h.db, {
        commentId: 'cmt_01JB7AUDIT00000000000000A',
        verdict: 'OFF',
        reason: '   ',
        by: null,
        at,
      }),
    ).toMatchObject({ code: 'AUDIT_REASON_REQUIRED' });

    // The module enforces the same bounds as the CLI: it is the writer of the columns.
    expect(
      recordAudit(h.db, {
        commentId: 'cmt_01JB7AUDIT00000000000000A',
        verdict: 'OFF',
        reason: 'я'.repeat(201),
        by: null,
        at,
      }),
    ).toMatchObject({ code: 'AUDIT_REASON_TOO_LONG' });
    expect(
      recordAudit(h.db, {
        commentId: 'cmt_01JB7AUDIT00000000000000A',
        verdict: 'FITS',
        reason: null,
        by: 'x'.repeat(65),
        at,
      }),
    ).toMatchObject({ code: 'AUDIT_LABEL_TOO_LONG' });
    expect(auditRow(h, 'cmt_01JB7AUDIT00000000000000A')).toMatchObject({ audit_verdict: null });

    // A non-CLI caller cannot store a multi-line reason: one line, bounded after folding.
    seed(h, 'cmt_01JB7AUDIT00000000000000C');
    expect(
      recordAudit(h.db, {
        commentId: 'cmt_01JB7AUDIT00000000000000C',
        verdict: 'OFF',
        reason: 'вне книги:\n\n  этот   мир\nне просит чудес',
        by: null,
        at,
      }),
    ).toEqual({ ok: true, verdict: 'OFF' });
    expect(auditRow(h, 'cmt_01JB7AUDIT00000000000000C')).toMatchObject({
      audit_reason: 'вне книги: этот мир не просит чудес',
      reason: 'вне книги: этот мир не просит чудес',
      status: 'rejected',
    });

    expect(
      recordAudit(h.db, {
        commentId: 'cmt_01JB7AUDIT00000000000000A',
        verdict: 'FITS',
        reason: null,
        by: 'triage-1',
        at,
      }),
    ).toEqual({ ok: true, verdict: 'FITS' });
    expect(
      recordAudit(h.db, {
        commentId: 'cmt_01JB7AUDIT00000000000000A',
        verdict: 'OFF',
        reason: 'поздно',
        by: null,
        at,
      }),
    ).toMatchObject({ code: 'AUDIT_ALREADY_RECORDED' });

    seed(h, 'cmt_01JB7AUDIT00000000000000B');
    h.db
      .prepare(`UPDATE comments SET status = 'rejected', decided_at = ?, reason = ? WHERE id = ?`)
      .run(at, 'не по тексту', 'cmt_01JB7AUDIT00000000000000B');
    expect(
      recordAudit(h.db, {
        commentId: 'cmt_01JB7AUDIT00000000000000B',
        verdict: 'FITS',
        reason: null,
        by: null,
        at,
      }),
    ).toMatchObject({ code: 'AUDIT_ALREADY_DECIDED' });
  });

  it('refuses an OFF comment at acceptComment even when called directly', async () => {
    const h = await boot();
    const id = await comment(h);
    expect(cli(h, 'audit', id, '--verdict', 'OFF', '--reason', 'вне книги: не про этот мир').code).toBe(0);

    const refused = acceptComment(h.db, {
      comment: readCommentRow(h.db, id)!,
      intent: 'в абзаце дважды «слово» — оставить одно',
      at: h.clock.now().toISOString(),
      reason: 'повтор',
    });
    expect(refused).toMatchObject({ code: 'AUDIT_REQUIRED' });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });
  });

  it('accepts a FITS comment once: a repeated call returns the same change, not a second one', async () => {
    const h = await boot();
    const id = await comment(h);
    expect(cli(h, 'audit', id, '--verdict', 'FITS').code).toBe(0);
    const input = {
      comment: readCommentRow(h.db, id)!,
      intent: 'в абзаце дважды «слово» — оставить одно',
      at: h.clock.now().toISOString(),
      reason: 'повтор',
    };

    const first = acceptComment(h.db, input);
    expect(first).toMatchObject({ created: true });
    const second = acceptComment(h.db, input);
    expect(second).toEqual({ changeId: (first as { changeId: string }).changeId, created: false });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 1 });

    // The pre-BOOK-9 shape: a row that already owns a change keeps its idempotent answer
    // even though it carries no verdict; the gate still runs for every new accept.
    h.db.prepare('UPDATE comments SET audit_verdict = NULL, audit_reason = NULL WHERE id = ?').run(id);
    const legacy = acceptComment(h.db, { ...input, comment: readCommentRow(h.db, id)! });
    expect(legacy).toEqual({ changeId: (first as { changeId: string }).changeId, created: false });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 1 });
  });
});
