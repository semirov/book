/**
 * BOOK-174 — the chain reaches the row, the DTO and the decision frame.
 *
 * Three facts, one writer each: an acceptance stores how the filing was read, in the same
 * transaction as its status; a content rejection without a lock becomes `escalated` and writes
 * no change; a rights refusal stays `rejected` under the rights lock. The report on the DTO is
 * derived from the stored chain, so the anchor a reader sees is the one the row really has.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DISPOSITION_REASONS, ESCALATION_QUESTION } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { insertComment, readCommentRow, toCommentDto, type CommentRow } from '../../src/comments/repo.ts';
import { upsertIdentity } from '../../src/db/repo/identities.ts';
import { acceptComment } from '../../src/feedback/accept.ts';
import { runFeedback } from '../../src/feedback/cli.ts';
import { DecisionsTailer } from '../../src/feedback/decisions.ts';
import { dispositionCaps } from '../../src/feedback/dispositionStore.ts';
import { bootComments, commentBody, type Harness } from '../comments/helpers.ts';

let harness: Harness | null = null;
let dir: string | null = null;

const QUOTE = 'Тестовый абзац номер один.';
const WORDING = 'В регистратуре выдают уведомление: срок тридцать дней и подпись.';
const KEPT = 'срок тридцать дней и подпись';
const INTENT = 'в абзаце дважды «слово» — оставить одно';

afterEach(async () => {
  await harness?.close();
  harness = null;
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function boot(): Promise<Harness> {
  harness = await bootComments();
  dir = mkdtempSync(join(tmpdir(), 'book-disposition-'));
  return harness;
}

function cli(h: Harness, ...argv: string[]): { code: number; out: string[] } {
  const out: string[] = [];
  const code = runFeedback(argv, { db: h.db, dir: dir ?? '', now: h.clock.now, print: (line) => out.push(line) });
  return { code, out };
}

/** A filed intervention on the first paragraph of ch08, audited and so ready for a decision. */
async function filed(h: Harness): Promise<string> {
  const block = h.db.prepare('SELECT id FROM blocks WHERE chapter = 8 ORDER BY idx LIMIT 1').get() as { id: string };
  const posted = await h.app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: h.headers(),
    payload: commentBody({ chapter: 8, blockId: block.id, quote: QUOTE, body: 'Бумага вместо сцены.', proposedText: WORDING }),
  });
  expect(posted.statusCode).toBe(201);
  const id = posted.json().comment.id as string;
  expect(cli(h, 'audit', id, '--verdict', 'FITS').code).toBe(0);
  return id;
}

describe('an accepted filing stores its chain (BOOK-174)', () => {
  it('takes the words as said when one sentence resolved and nothing established moved', async () => {
    const h = await boot();
    const id = await filed(h);
    expect(cli(h, 'decide', id, 'accepted', '--reason', 'входит в книгу', '--intent', INTENT).code).toBe(0);

    const row = readCommentRow(h.db, id);
    expect(row).toMatchObject({ status: 'accepted', disposition: 'as_said', lock: null, carrier_kind: null });
    // ADR-044's anchor, the filing's own — never a place string the reading invented.
    expect(row?.sentence_id).toMatch(/^snt_/u);
    // The DTO renders the real anchor: block_idx is 0-based in storage, 1-based on the page.
    const dto = toCommentDto(h.db, row!);
    expect(dto.disposition).toBe('as_said');
    expect(dto.report).toMatchObject({
      line1: 'прочитано как сказано',
      line2: DISPOSITION_REASONS.as_said,
      line3: 'где это в книге: глава 8 · абзац 1 · предложение 1',
    });
  });

  it('accepts a through_paper reading as an ordinary change — the step writes the document', async () => {
    const h = await boot();
    const id = await filed(h);
    const accepted = acceptComment(h.db, {
      comment: readCommentRow(h.db, id)!,
      intent: INTENT,
      at: h.clock.now().toISOString(),
      reason: 'входит в книгу',
      proposal: { disposition: 'through_paper', carrierKind: 'document', quoteKept: KEPT, factsChanged: 1 },
    });
    expect('changeId' in accepted).toBe(true);

    const row = readCommentRow(h.db, id);
    expect(row).toMatchObject({ status: 'accepted', disposition: 'through_paper', carrier_kind: 'document' });
    expect(row?.quote_kept).toBe(KEPT);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 1 });
    // Both plans existed: the report names the one that was declined.
    const report = toCommentDto(h.db, row!).report;
    expect(report?.line1).toBe('прочитано через бумагу, а не как сказано');
    expect(report?.line3).toBe('где это в книге: глава 8 · абзац 1 · предложение 1 — документ');
  });

  it('lands an acceptance the ladder cannot license on the as_said floor, on its block anchor', async () => {
    const h = await boot();
    const id = await filed(h);
    // ADR-044's «never guess»: a quote that resolved to no single sentence keeps the block
    // anchor, so nothing can be said to stand in one — and the ladder is total (ADR-045 §5):
    // the floor answers instead of a person, and the change is written.
    h.db
      .prepare('UPDATE comments SET sentence_id = NULL, sel_start = NULL, sel_end = NULL WHERE id = ?')
      .run(id);

    const accepted = acceptComment(h.db, {
      comment: readCommentRow(h.db, id)!,
      intent: INTENT,
      at: h.clock.now().toISOString(),
      reason: 'входит в книгу',
    });
    expect(accepted).not.toMatchObject({ escalated: true });
    expect(readCommentRow(h.db, id)).toMatchObject({
      status: 'accepted',
      disposition: 'as_said',
      carrier_kind: null,
      sentence_id: null,
    });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 1 });
  });
});

describe('a content rejection outside a lock escalates (BOOK-174)', () => {
  it('records the author’s question on the CLI, with no change and no rejection', async () => {
    const h = await boot();
    const id = await filed(h);
    const rejected = cli(h, 'decide', id, 'rejected', '--reason', 'вне рамок: не про текст');
    expect(rejected.code).toBe(0);
    expect(rejected.out.join('\n')).toContain('escalated');

    const row = readCommentRow(h.db, id);
    expect(row).toMatchObject({
      status: 'escalated',
      disposition: 'escalated',
      reason: ESCALATION_QUESTION,
      lock: null,
      change_id: null,
    });
    expect(row?.decided_at).not.toBeNull();
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'escalated'`).get()).toEqual({ n: 1 });
    expect(toCommentDto(h.db, row!).report).toEqual({
      line1: 'ждёт решения автора',
      line2: DISPOSITION_REASONS.escalated,
      line3: 'решает автор',
    });
  });
});

describe('the caps are read from the rows (BOOK-174 §6)', () => {
  function seed(h: Harness, id: string, disposition: string, decidedAt: string, stamp: string | null): void {
    insertComment(h.db, {
      id,
      identityId: h.identity.id,
      chapter: 8,
      blockId: null,
      blockIndex: null,
      baseRev: 1,
      quote: null,
      prefix: null,
      suffix: null,
      author: 'Аня',
      body: 'Служебное замечание.',
      proposedText: null,
      interventionKind: null,
      bodySha: `sha-${id}`,
      flags: [],
      ipHash: 'f'.repeat(64),
      status: 'accepted',
      guard: null,
      reason: null,
      createdAt: decidedAt,
      idemKey: null,
    });
    h.db
      .prepare('UPDATE comments SET disposition = ?, quote_kept = ?, decided_at = ? WHERE id = ?')
      .run(disposition, stamp, decidedAt, id);
  }

  /** A row of this reader, in this chapter, that no decision has touched yet. */
  function pending(h: Harness): CommentRow {
    const id = 'cmt_pending_caps';
    insertComment(h.db, {
      id,
      identityId: h.identity.id,
      chapter: 8,
      blockId: null,
      blockIndex: null,
      baseRev: 1,
      quote: null,
      prefix: null,
      suffix: null,
      author: 'Аня',
      body: 'Ещё одно замечание.',
      proposedText: null,
      interventionKind: null,
      bodySha: 'b'.repeat(64),
      flags: [],
      ipHash: 'f'.repeat(64),
      status: 'new',
      guard: null,
      reason: null,
      createdAt: '2026-10-25T11:00:00Z',
      idemKey: null,
    });
    return readCommentRow(h.db, id)!;
  }

  it('counts this reader’s refusals, the chapter’s stamps and the trailing run', async () => {
    const h = await boot();
    seed(h, 'cmt_r1', 'refused_in_world', '2026-10-25T10:00:00Z', 'не соответствует форме');
    seed(h, 'cmt_r2', 'refused_in_world', '2026-10-25T10:01:00Z', 'нет в перечне');

    const row = pending(h);
    expect(dispositionCaps(h.db, row, 'не соответствует форме')).toEqual({
      inWorldInChapterByReader: 2,
      stampUsedInChapter: true,
      runBefore: 2,
    });
    // A stamp nobody used is not "used".
    expect(dispositionCaps(h.db, row, 'новая формулировка').stampUsedInChapter).toBe(false);
  });

  it('ends the run at a landing: a refused_in_world in between is not a sequence', async () => {
    const h = await boot();
    seed(h, 'cmt_r1', 'refused_in_world', '2026-10-25T10:00:00Z', 'не соответствует форме');
    seed(h, 'cmt_landed', 'as_said', '2026-10-25T10:01:00Z', null);
    expect(dispositionCaps(h.db, pending(h), null).runBefore).toBe(0);
  });

  it('counts another reader’s refusals in the chapter without their cap biting', async () => {
    const h = await boot();
    const other = upsertIdentity(h.db, { yandexSub: 'yandex-other', displayName: 'Боря', at: '2026-10-25T09:00:00Z' });
    insertComment(h.db, {
      id: 'cmt_other',
      identityId: other.id,
      chapter: 8,
      blockId: null,
      blockIndex: null,
      baseRev: 1,
      quote: null,
      prefix: null,
      suffix: null,
      author: 'Боря',
      body: 'Замечание другого читателя.',
      proposedText: null,
      interventionKind: null,
      bodySha: 'c'.repeat(64),
      flags: [],
      ipHash: 'e'.repeat(64),
      status: 'accepted',
      guard: null,
      reason: null,
      createdAt: '2026-10-25T10:00:00Z',
      idemKey: null,
    });
    h.db
      .prepare(`UPDATE comments SET disposition = 'refused_in_world', quote_kept = 'не соответствует форме' WHERE id = 'cmt_other'`)
      .run();
    const caps = dispositionCaps(h.db, pending(h), 'не соответствует форме');
    // The stamp is the chapter's, so it is used; the per-reader cap has this reader at zero.
    expect(caps).toEqual({ inWorldInChapterByReader: 0, stampUsedInChapter: true, runBefore: 1 });
  });
});

describe('a refusal is a lock (BOOK-174)', () => {
  it('keeps the rights refusal rejected, with the rights lock on the chain', async () => {
    const h = await boot();
    // A stopped filing: the scan flagged it, so no verdict stands and the gate may speak.
    const id = 'cmt_rights_lock';
    insertComment(h.db, {
      id,
      identityId: h.identity.id,
      chapter: 8,
      blockId: null,
      blockIndex: null,
      baseRev: 1,
      quote: null,
      prefix: null,
      suffix: null,
      author: 'Аня',
      body: 'Чужая цитата без источника.',
      proposedText: null,
      interventionKind: null,
      bodySha: 'a'.repeat(64),
      flags: ['rights-flag'],
      ipHash: 'f'.repeat(64),
      status: 'new',
      guard: null,
      reason: null,
      createdAt: '2026-10-25T12:00:00Z',
      idemKey: null,
    });
    expect(
      cli(h, 'rights', id, '--verdict', 'REFUSED', '--rule', 'RIGHTS-PARAPHRASE', '--source', 'Пелевин').code,
    ).toBe(0);
    const row = readCommentRow(h.db, id);
    expect(row).toMatchObject({ status: 'rejected', disposition: 'inadmissible', lock: 'rights' });
    expect(toCommentDto(h.db, row!).report).toEqual({
      line1: 'не принято',
      line2: 'потому что это не ваш текст',
      line3:
        'сработает иначе: перескажите своими в пяти словах — пересказ войдёт в бланк, в протокол или в чью-то реплику',
    });
  });

  it('keeps a gate that has not spoken out of the ladder entirely', async () => {
    const h = await boot();
    const posted = await h.app.inject({
      method: 'POST',
      url: '/api/comments',
      headers: h.headers(),
      payload: commentBody({ chapter: 8, body: 'Замечание без аудита.' }),
    });
    const id = posted.json().comment.id as string;
    const decided = cli(h, 'decide', id, 'accepted', '--reason', 'входит в книгу', '--intent', INTENT);
    expect(decided.code).toBe(1);
    expect(decided.out.join('\n')).toContain('AUDIT_REQUIRED');
    // Today's behaviour, untouched: the row stays undecided and carries no chain.
    expect(readCommentRow(h.db, id)).toMatchObject({ status: 'new', disposition: null, decided_at: null });
  });
});

describe('the decision line carries the reading (BOOK-174)', () => {
  it('applies a proposal from decisions.jsonl and emits the report with the frame', async () => {
    const h = await boot();
    const id = await filed(h);
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
        reason: 'входит в книгу',
        intent: INTENT,
        at: h.clock.now().toISOString(),
        disposition: { disposition: 'through_paper', carrierKind: 'document', quoteKept: KEPT, factsChanged: 1 },
      })}\n`,
      'utf8',
    );
    expect(tailer.poll()).toBeGreaterThan(0);

    const row = readCommentRow(h.db, id);
    expect(row).toMatchObject({ disposition: 'through_paper', carrier_kind: 'document', quote_kept: KEPT });
    const frame = emitted.find((event) => event.type === 'comment:decision');
    expect(frame?.data).toMatchObject({
      status: 'accepted',
      report: {
        line1: 'прочитано через бумагу, а не как сказано',
        line3: 'где это в книге: глава 8 · абзац 1 · предложение 1 — документ',
      },
    });
  });

  it('drops a disposition word this build does not know instead of guessing one', async () => {
    const h = await boot();
    const id = await filed(h);
    const tailer = new DecisionsTailer({
      db: h.db,
      dir: dir ?? '',
      emit: () => undefined,
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
        reason: 'входит в книгу',
        intent: INTENT,
        at: h.clock.now().toISOString(),
        disposition: { disposition: 'wide', carrierKind: 'letter' },
      })}\n`,
      'utf8',
    );
    tailer.poll();
    // «wide» and «letter» are not this build's words: the row is read as said, not as a refusal.
    expect(readCommentRow(h.db, id)).toMatchObject({ disposition: 'as_said', carrier_kind: null });
  });
});

describe('the finale lock is the one a decision may name (BOOK-174 §4)', () => {
  it('refuses the filing as inadmissible and keeps its chain, with no change', async () => {
    const h = await boot();
    const id = await filed(h);
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
        reason: 'входит в книгу',
        intent: INTENT,
        at: h.clock.now().toISOString(),
        disposition: { disposition: 'inadmissible', lock: 'finale' },
      })}\n`,
      'utf8',
    );
    expect(tailer.poll()).toBeGreaterThan(0);

    const row = readCommentRow(h.db, id);
    expect(row).toMatchObject({ status: 'rejected', disposition: 'inadmissible', lock: 'finale', change_id: null });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });
    expect(toCommentDto(h.db, row!).report).toEqual({
      line1: 'не принято',
      line2: 'потому что это отменяет исход',
      line3: 'сработает иначе: те же слова — как заявление, которое отклоняют, или как вера героя, который ошибается',
    });
    expect(emitted.find((event) => event.type === 'comment:decision')?.data).toMatchObject({ status: 'rejected' });
  });
});

/**
 * Blocker from the review: an escalated filing is not a dead end. The author answers with the
 * same `decide` every other decision goes through — `accepted` places it (an ordinary change),
 * `rejected` ends it — and a replayed line changes nothing.
 */
