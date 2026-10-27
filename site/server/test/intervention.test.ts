import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EDIT_DAY_MS,
  INTERVENTION_KINDS,
  INTERVENTION_KIND_HINT,
  INTERVENTION_KIND_LABELS,
  INTERVENTION_KIND_LIST,
  interventionKindLabel,
  normalizeInterventionKind,
  validateInterventionKind,
  validateIntent,
  type InterventionKind,
} from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { insertComment } from '../src/comments/repo.ts';
import { upsertIdentity } from '../src/db/repo/identities.ts';
import { readBatchLines } from '../src/feedback/batches.ts';
import { runFeedback } from '../src/feedback/cli.ts';
import { DecisionsTailer } from '../src/feedback/decisions.ts';
import { bootComments, commentBody, type Harness } from './comments/helpers.ts';
import { createEngineFixture, runStubStep } from './engine/helpers.ts';
import { longProse } from './helpers.ts';

/**
 * BOOK-16 — an intervention is one of four world-facts (BOOK-DOC-4 rule 1).
 *
 * One closed set in shared, stored with the comment, carried to the change, the batch line
 * triage reads, the auditor's verdict and the writer's assignment. A row stored before
 * BOOK-16 has no kind and is decided exactly as before; a new intervention without one is
 * refused with a code at every boundary that accepts the reader's text.
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
  dir = mkdtempSync(join(tmpdir(), 'book-intervention-'));
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

/** POST one intervention with the given kind; returns the response body. */
async function postIntervention(
  h: Harness,
  kind: string | undefined,
  options: { proposedText?: string; body?: string } = {},
): Promise<{ statusCode: number; json: () => any }> {
  const payload = commentBody({
    body: options.body ?? 'В главе 8 подписан отказ на пропуск.',
    proposedText: options.proposedText ?? 'Отказ подписан.',
    ...(kind === undefined ? { interventionKind: undefined } : { interventionKind: kind }),
  });
  // A test that asserts the missing-kind refusal must really send no kind.
  if (kind === undefined) delete (payload as { interventionKind?: string }).interventionKind;
  return h.app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: h.headers(),
    payload,
  });
}

describe('the four kinds are one closed set (BOOK-16)', () => {
  it('has stable ids and one Russian label each', () => {
    expect([...INTERVENTION_KINDS]).toEqual(['document', 'decision', 'testimony', 'erasure']);
    expect(INTERVENTION_KIND_LABELS).toEqual({
      document: 'документ',
      decision: 'решение героя',
      testimony: 'свидетельство',
      erasure: 'стёртая деталь',
    });
    expect(INTERVENTION_KIND_LIST).toBe('документ · решение героя · свидетельство · стёртая деталь');
    expect(INTERVENTION_KIND_HINT).toBe(`что вы вносите: ${INTERVENTION_KIND_LIST}`);
  });

  it('refuses a missing kind and an unknown one with a code, and accepts each of the four', () => {
    expect(validateInterventionKind(undefined)).toMatchObject({ ok: false, code: 'INTERVENTION_KIND_REQUIRED' });
    expect(validateInterventionKind('')).toMatchObject({ ok: false, code: 'INTERVENTION_KIND_REQUIRED' });
    expect(validateInterventionKind('magic')).toMatchObject({ ok: false, code: 'INTERVENTION_KIND_UNKNOWN' });
    for (const kind of INTERVENTION_KINDS) {
      expect(validateInterventionKind(kind)).toEqual({ ok: true, kind });
    }
  });

  it('prints a label, never an id, and drops a value the build does not know', () => {
    expect(interventionKindLabel('erasure')).toBe('стёртая деталь');
    expect(interventionKindLabel(null)).toBeNull();
    expect(interventionKindLabel('magic')).toBeNull();
    expect(normalizeInterventionKind(undefined)).toBeNull();
    expect(normalizeInterventionKind(' document ')).toBe('document');
  });
});

describe('an intervention kind end to end (BOOK-16)', () => {
  it('carries each of the four kinds from POST through the batch and triage to the change', async () => {
    const h = await boot();
    for (const [index, kind] of INTERVENTION_KINDS.entries()) {
      // One edit per day per reader and per address: each kind is posted on its own day.
      if (index > 0) h.clock.advance(EDIT_DAY_MS + 1_000);
      const response = await postIntervention(h, kind, {
        body: `Замечание номер ${index} к главе 8: подписан отказ на пропуск.`,
        proposedText: `Отказ подписан (${index}).`,
      });
      expect(response.statusCode, kind).toBe(201);
      const dto = response.json().comment as { id: string; interventionKind: string | null };
      expect(dto.interventionKind).toBe(kind);

      // The batch line triage reads carries the kind, not only the note.
      const inbox = cli(h, 'inbox', '--limit', '5');
      expect(inbox.code).toBe(0);
      // The auditor is told the kind beside the id it is judging.
      expect(inbox.out.join('\n')).toContain(INTERVENTION_KIND_LABELS[kind]);
      const batch = h.db.prepare('SELECT id FROM feedback_batches ORDER BY created_at DESC LIMIT 1').get() as {
        id: string;
      };
      const [item] = readBatchLines(dir ?? '', batch.id).filter((line) => line.itemId === dto.id);
      expect(item?.kind, kind).toBe(kind);
      // The batch is closed for the next round: the comment is `batched`, and the next inbox
      // must not pick it again.
      expect(cli(h, 'read', batch.id).code).toBe(0);
      expect(cli(h, 'close', batch.id).code).toBe(0);

      expect(cli(h, 'audit', dto.id, '--verdict', 'FITS').code).toBe(0);
      const decided = cli(
        h,
        'decide',
        dto.id,
        'accepted',
        '--reason',
        'входит в книгу',
        '--intent',
        'подписан отказ на пропуск',
      );
      expect(decided.code, decided.out.join('\n')).toBe(0);

      const change = h.db.prepare('SELECT id, intervention_kind FROM changes WHERE source_comment = ?').get(dto.id) as
        | { id: string; intervention_kind: string | null }
        | undefined;
      expect(change?.intervention_kind, kind).toBe(kind);

      // The public card reads the same fact, as the id the renderer turns into one word.
      const card = await h.app.inject({ method: 'GET', url: `/api/changes/${change?.id ?? ''}` });
      expect(card.statusCode).toBe(200);
      expect((card.json() as { interventionKind: string | null }).interventionKind).toBe(kind);
    }
  }, 30_000);

  it('carries the kind on the site’s own accept path — the decisions tailer', async () => {
    const h = await boot();
    const response = await postIntervention(h, 'decision', {
      body: 'Смотритель решает не открывать шлюз.',
      proposedText: 'Шлюз не открыт.',
    });
    const id = response.json().comment.id as string;
    expect(cli(h, 'audit', id, '--verdict', 'FITS').code).toBe(0);
    // A decision line written while the site was down: the tailer is the one that accepts.
    mkdirSync(dir ?? '', { recursive: true });
    appendFileSync(
      join(dir ?? '', 'decisions.jsonl'),
      `${JSON.stringify({
        id,
        status: 'accepted',
        reason: 'входит в книгу',
        intent: 'смотритель решает не открывать шлюз',
        at: h.clock.now().toISOString(),
      })}\n`,
      'utf8',
    );
    const tailer = new DecisionsTailer({
      db: h.db,
      dir: dir ?? '',
      emit: () => undefined,
      now: h.clock.now,
      replay: true,
    });
    tailer.prime();
    expect(tailer.poll()).toBeGreaterThanOrEqual(1);
    expect(
      h.db.prepare('SELECT intervention_kind FROM changes WHERE source_comment = ?').get(id),
    ).toEqual({ intervention_kind: 'decision' });
  });

  it('refuses a stored kind this build does not know — in the CLI and in the tailer — and leaves the comment undecided', async () => {
    const h = await boot();
    const response = await postIntervention(h, 'document', {
      body: 'В главе 8 подписан отказ на пропуск.',
      proposedText: 'Отказ подписан.',
    });
    const id = response.json().comment.id as string;
    // A newer build wrote a kind this one has never heard of. The CHECK is bypassed the way a
    // future migration would leave the value in the row.
    h.db.pragma('ignore_check_constraints = ON');
    h.db.prepare('UPDATE comments SET intervention_kind = ? WHERE id = ?').run('signature', id);
    h.db.pragma('ignore_check_constraints = OFF');
    expect(cli(h, 'audit', id, '--verdict', 'FITS').code).toBe(0);

    // The CLI refuses with a code and writes nothing.
    const refusedByCli = cli(
      h,
      'decide',
      id,
      'accepted',
      '--reason',
      'входит в книгу',
      '--intent',
      'подписан отказ на пропуск',
    );
    expect(refusedByCli.code).toBe(1);
    expect(refusedByCli.out.join('\n')).toContain('INTERVENTION_KIND_UNKNOWN');

    // The tailer applies the same rule: the line is not applied, nothing is announced, the
    // comment stays undecided (triage sees it again), and the refusal is on its record.
    mkdirSync(dir ?? '', { recursive: true });
    appendFileSync(
      join(dir ?? '', 'decisions.jsonl'),
      `${JSON.stringify({
        id,
        status: 'accepted',
        reason: 'входит в книгу',
        intent: 'подписан отказ на пропуск',
        at: h.clock.now().toISOString(),
      })}\n`,
      'utf8',
    );
    const emitted: string[] = [];
    const tailer = new DecisionsTailer({
      db: h.db,
      dir: dir ?? '',
      emit: (type) => emitted.push(type),
      now: h.clock.now,
      replay: true,
    });
    tailer.prime();
    expect(tailer.poll()).toBe(0);
    expect(emitted).toEqual([]);
    expect(h.db.prepare('SELECT status, decided_at FROM comments WHERE id = ?').get(id)).toEqual({
      status: 'new',
      decided_at: null,
    });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });
    expect(
      h.db.prepare('SELECT type FROM comment_events WHERE comment_id = ? ORDER BY id DESC LIMIT 1').get(id),
    ).toEqual({ type: 'decision-refused' });
  });

  it('refuses a new intervention with no kind, with a code', async () => {
    const h = await boot();
    const response = await postIntervention(h, undefined);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'INTERVENTION_KIND_REQUIRED' });
    // Nothing was stored: a refusal does not leave a comment behind.
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM comments').get()).toEqual({ n: 0 });
  });

  it('refuses an unknown kind, with a code', async () => {
    const h = await boot();
    const response = await postIntervention(h, 'magic');
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'INTERVENTION_KIND_UNKNOWN' });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM comments').get()).toEqual({ n: 0 });
  });

  it('refuses a kind on a note: a note is not an intervention', async () => {
    const h = await boot();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/comments',
      headers: h.headers(),
      payload: commentBody({ body: 'Тут повтор слова — оставить одно упоминание.', interventionKind: 'document' }),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'INTERVENTION_KIND_WITHOUT_TEXT' });
  });

  it('decides an old intervention that has no kind, and its change carries none', async () => {
    const h = await boot();
    const identity = upsertIdentity(h.db, {
      yandexSub: 'yandex-old',
      displayName: 'Аня',
      at: '2026-10-24T12:00:00Z',
    });
    // A row stored before BOOK-16: an intervention with `proposed_text` and no kind at all.
    insertComment(h.db, {
      id: 'cmt_01JB7OLD00000000000000000',
      identityId: identity.id,
      chapter: 8,
      blockId: null,
      blockIndex: null,
      baseRev: 1,
      quote: null,
      prefix: null,
      suffix: null,
      author: 'Аня',
      body: 'Старое замечание к главе 8.',
      proposedText: 'Старая правка абзаца.',
      interventionKind: null,
      bodySha: 'b'.repeat(64),
      flags: [],
      ipHash: 'e'.repeat(64),
      status: 'new',
      guard: null,
      reason: null,
      createdAt: '2026-10-24T12:01:00Z',
      idemKey: null,
    });
    expect(cli(h, 'audit', 'cmt_01JB7OLD00000000000000000', '--verdict', 'FITS').code).toBe(0);
    // BOOK-61: a row stored before the scan existed still needs its right cleared — the batch
    // boundary or an operator writes it; acceptance has no default.
    h.db.prepare(`UPDATE comments SET rights_verdict = 'CLEAR' WHERE id = ?`).run('cmt_01JB7OLD00000000000000000');
    const decided = cli(
      h,
      'decide',
      'cmt_01JB7OLD00000000000000000',
      'accepted',
      '--reason',
      'входит в книгу',
      '--intent',
      'подписан отказ на пропуск',
    );
    expect(decided.code, decided.out.join('\n')).toBe(0);
    const change = h.db
      .prepare('SELECT intervention_kind FROM changes WHERE source_comment = ?')
      .get('cmt_01JB7OLD00000000000000000') as { intervention_kind: string | null } | undefined;
    expect(change?.intervention_kind).toBeNull();
  });
});

describe('the kind reaches the intent and the writer (BOOK-16)', () => {
  it('refuses an intent that is a prose correction when a kind is declared', () => {
    // The same goal is allowed without a kind (a note may be about the writing) …
    expect(validateIntent('убрать повтор слова в абзаце', 8).ok).toBe(true);
    // … and refused once the intervention claims to be a world-fact.
    for (const kind of INTERVENTION_KINDS) {
      const verdict = validateIntent('убрать повтор слова в абзаце', 8, { kind });
      expect(verdict, kind).toMatchObject({ ok: false, code: 'INTENT_PROSE_CORRECTION' });
    }
  });

  it('accepts a world-fact whose words merely start like prose mechanics (review BOOK-16)', () => {
    // Prefix stems refused all four: «повторный», «повторяющийся», «ритмичный», «падежная».
    for (const intent of [
      'убрать повторный допрос из дела',
      'убрать повторяющийся сон из главы',
      'убрать ритмичный стук из сцены',
      'внести приказ, где убрана падежная форма имени',
    ]) {
      for (const kind of INTERVENTION_KINDS) {
        expect(validateIntent(intent, 8, { kind }), `${kind}: ${intent}`).toMatchObject({ ok: true });
      }
    }
  });

  it('still refuses the prose correction itself, not only its neighbours', () => {
    for (const intent of [
      'убрать повтор в абзаце',
      'исправь запятую в третьем абзаце',
      'поправь ритм последней сцены',
      'добавь пробел после тире',
    ]) {
      expect(validateIntent(intent, 8, { kind: 'document' }), intent).toMatchObject({
        ok: false,
        code: 'INTENT_PROSE_CORRECTION',
      });
    }
  });

  it('keeps a real world-fact with a declared kind, including the word «деталь»', () => {
    for (const [kind, intent] of [
      ['document', 'подписан отказ на пропуск'],
      ['decision', 'смотритель решает не открывать шлюз'],
      ['testimony', 'свидетельство о переписи приложено к делу'],
      ['erasure', 'стереть из дела упоминание о смотрителе'],
    ] as Array<[InterventionKind, string]>) {
      expect(validateIntent(intent, 8, { kind }), intent).toMatchObject({ ok: true });
    }
  });

  it('puts the comment’s kind on the writer’s assignment', () => {
    const fixture = createEngineFixture();
    try {
      runStubStep(fixture, { title: 'Документ', blocks: ['Тестовый абзац номер один. Это служебный текст.'] });
      const identity = upsertIdentity(fixture.db, {
        yandexSub: 'yandex-writer',
        displayName: 'Аня',
        at: '2026-10-25T12:00:00Z',
      });
      insertComment(fixture.db, {
        id: 'cmt_01JB7KIND0000000000000000',
        identityId: identity.id,
        chapter: 1,
        blockId: null,
        blockIndex: null,
        baseRev: 1,
        quote: null,
        prefix: null,
        suffix: null,
        author: 'Аня',
        body: 'Приложить отказ на пропуск.',
        proposedText: 'Отказ приложен к делу.',
        interventionKind: 'document',
        bodySha: 'c'.repeat(64),
        flags: [],
        ipHash: 'd'.repeat(64),
        status: 'new',
        guard: null,
        reason: null,
        createdAt: '2026-10-25T12:01:00Z',
        idemKey: null,
      });
      fixture.db
        .prepare(`UPDATE comments SET audit_verdict = 'FITS', audited_at = ?, rights_verdict = 'CLEAR' WHERE id = ?`)
        .run('2026-10-25T12:02:00Z', 'cmt_01JB7KIND0000000000000000');
      const change = fixture.engine.enqueue({
        kind: 'accepted_comment',
        chapter: 1,
        intent: 'подписан отказ на пропуск',
        commentId: 'cmt_01JB7KIND0000000000000000',
      });
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-kind' });
      expect(assignment).not.toBeNull();
      expect(assignment).toMatchObject({ changeId: change.id, interventionKind: 'document' });
    } finally {
      fixture.close();
    }
  });
});
