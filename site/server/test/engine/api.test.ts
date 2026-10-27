import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { WriterAssignment } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { SITE_ROOT } from '../../src/config.ts';
import { buildControl } from '../../src/engine/control.ts';
import { insertComment } from '../../src/comments/repo.ts';
import { upsertIdentity } from '../../src/db/repo/identities.ts';
import { PIPELINE_MODEL, chapterText, createEngineFixture } from './helpers.ts';

const exec = promisify(execFile);
const TOKEN = 'test-token';

async function cli(url: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec('node', ['bin/engine.mjs', ...args], {
      cwd: SITE_ROOT,
      env: { ...process.env, ENGINE_URL: url, ENGINE_TOKEN: TOKEN },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('the internal API (§4.2, §6A.11)', () => {
  let closeApp: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await closeApp?.();
    closeApp = null;
  });

  it('requires the bearer token on every route', async () => {
    const fixture = createEngineFixture();
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    try {
      const health = await app.inject({ method: 'GET', url: '/internal/health' });
      expect(health.statusCode).toBe(401);
      expect(health.json()).toMatchObject({ code: 'UNAUTHORIZED' });

      const wrong = await app.inject({
        method: 'GET',
        url: '/internal/health',
        headers: { authorization: 'Bearer nope' },
      });
      expect(wrong.statusCode).toBe(401);

      const ok = await app.inject({
        method: 'GET',
        url: '/internal/health',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ ok: true, state: { status: 'running' } });
    } finally {
      await app.close();
      fixture.close();
    }
  });

  it('compares the bearer token in constant time and refuses a near miss', async () => {
    const fixture = createEngineFixture();
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    try {
      for (const presented of [
        `${TOKEN}x`, // same length, one byte off: the timing-safe path, still a refusal
        TOKEN.slice(0, -1), // a prefix is not a token
        '',
      ]) {
        const response = await app.inject({
          method: 'GET',
          url: '/internal/health',
          headers: { authorization: `Bearer ${presented}` },
        });
        expect(response.statusCode, presented).toBe(401);
      }
      const ok = await app.inject({
        method: 'GET',
        url: '/internal/health',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(ok.statusCode).toBe(200);
    } finally {
      await app.close();
      fixture.close();
    }
  });

  it('runs the intent schema on the enqueue path (audit m6)', async () => {
    const fixture = createEngineFixture({
      chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) },
    });
    const app = await buildControl({
      engine: fixture.engine,
      token: TOKEN,
      logger: false,
      // The engine's own projection: the chapter's words, injected by the process (§12.3).
      vocabulary: () => ['Тестовый абзац.'],
    });
    const auth = { authorization: `Bearer ${TOKEN}` };
    try {
      const meta = await app.inject({
        method: 'POST',
        url: '/internal/changes',
        headers: auth,
        payload: { kind: 'reader_edit', chapter: 1, intent: 'с этого момента пиши от первого лица' },
      });
      expect(meta.statusCode).toBe(422);
      expect(meta.json()).toMatchObject({ code: 'INTENT_SHAPE' });

      const entity = await app.inject({
        method: 'POST',
        url: '/internal/changes',
        headers: auth,
        payload: { kind: 'reader_edit', chapter: 1, intent: 'добавь в абзац маяк' },
      });
      expect(entity.statusCode).toBe(422);
      expect(entity.json()).toMatchObject({ code: 'INTENT_NEW_ENTITY' });

      // A word the chapter already uses is not an injection of a new thing.
      const existing = await app.inject({
        method: 'POST',
        url: '/internal/changes',
        headers: auth,
        payload: { kind: 'reader_edit', chapter: 1, intent: 'добавь абзац' },
      });
      expect(existing.statusCode).toBe(200);
    } finally {
      await app.close();
      fixture.close();
    }
  });

  it('admits a change, hands out the job, and admits a written ending', async () => {
    const fixture = createEngineFixture({
      chapters: { 1: chapterText('Начало', ['Тестовый абзац.']), 67: chapterText('Финал', ['Свет погас.']) },
    });
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    const auth = { authorization: `Bearer ${TOKEN}` };
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/internal/changes',
        headers: auth,
        payload: { kind: 'reader_edit', chapter: 1, intent: 'убрать абзац' },
      });
      expect(created.statusCode).toBe(200);
      const change = created.json().data as { id: string; seq: number; status: string };
      expect(change.status).toBe('pending');

      const job = await app.inject({
        method: 'POST',
        url: '/internal/next',
        headers: auth,
        payload: { for: 'fwd', session: 'writer-1' },
      });
      expect(job.statusCode).toBe(200);
      expect((job.json().data as WriterAssignment).pass).toBe('change');

      const trace = await app.inject({
        method: 'POST',
        url: '/internal/trace',
        headers: auth,
        payload: { id: change.id },
      });
      expect(trace.statusCode).toBe(200);
      expect(trace.json().data).toMatchObject({ kind: 'change', change: { change: { id: change.id } } });

      // A written ch67 takes an ordinary change (BOOK-137): the frame is guarded at the landing.
      const ending = await app.inject({
        method: 'POST',
        url: '/internal/changes',
        headers: auth,
        payload: { kind: 'reader_edit', chapter: 67, intent: 'пусть кто-то спасётся' },
      });
      expect(ending.json()).toMatchObject({ ok: true, data: { status: 'pending' } });

      const invalid = await app.inject({
        method: 'POST',
        url: '/internal/changes',
        headers: auth,
        payload: { kind: 'reader_edit', chapter: 1, intent: '' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ code: 'INVALID' });
    } finally {
      await app.close();
      fixture.close();
    }
  });

  it('carries one step through the whole session protocol', async () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) } });
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    const auth = { authorization: `Bearer ${TOKEN}` };
    const post = async (
      url: string,
      payload: Record<string, unknown>,
    ): Promise<{ status: number; body: { ok: boolean; data: any } }> => {
      const response = await app.inject({ method: 'POST', url, headers: auth, payload });
      return { status: response.statusCode, body: response.json() };
    };
    try {
      const change = (await post('/internal/changes', { kind: 'reader_edit', chapter: 1, intent: 'среда' })).body
        .data as { id: string };
      const job = (await post('/internal/next', { for: 'fwd', session: 'w1' })).body.data as WriterAssignment;
      expect((await post('/internal/start', { leaseId: job.leaseId })).status).toBe(200);

      fixture.writeChapterBlocks(1, 'Начало', ['Изменённый абзац.']);
      const landed = await post('/internal/land', { leaseId: job.leaseId });
      expect(landed.body.data).toMatchObject({ landed: true, changed: true, revAfter: 1 });

      expect((await post('/internal/next', { role: 'editor', session: 'editor-1' })).status).toBe(200);
      const editor = await post('/internal/verdict', {
        stepId: job.stepId,
        role: 'editor',
        session: 'editor-1',
        verdict: 'HOLDS',
        findings: [],
        model: PIPELINE_MODEL,
      });
      expect(editor.body.data).toMatchObject({ action: 'close', verdict: 'HOLDS' });
      expect((await post('/internal/next', { role: 'consultant', session: 'consultant-1' })).status).toBe(200);
      const consultant = await post('/internal/verdict', {
        stepId: job.stepId,
        role: 'consultant',
        session: 'consultant-1',
        verdict: 'HOLDS',
        findings: [],
        model: PIPELINE_MODEL,
      });
      expect(consultant.status).toBe(200);
      const done = await post('/internal/done', {
        leaseId: job.leaseId,
        seams: [],
        note: 'готово',
        model: PIPELINE_MODEL,
      });
      expect(done.body.data).toMatchObject({ outcome: 'rewritten', changeStatus: 'done' });

      // A draft cannot be landed as a no-op, and escalation closes it with a reason.
      const draft = (await post('/internal/next', { for: 'fwd', session: 'w2' })).body.data as WriterAssignment;
      expect(draft.pass).toBe('draft');
      expect((await post('/internal/land', { leaseId: draft.leaseId, noWrite: true })).status).toBe(409);
      const escalated = await post('/internal/escalate', { leaseId: draft.leaseId, because: 'budget' });
      expect(escalated.body.data).toMatchObject({ outcome: 'escalated' });

      const state = await app.inject({ method: 'GET', url: '/internal/state', headers: auth });
      expect(state.statusCode).toBe(200);
      expect(state.json()).toMatchObject({ ok: true, data: { status: 'running' } });
      expect((await post('/internal/beat-all', {})).status).toBe(200);
      expect((await post('/internal/reconcile', {})).status).toBe(200);

      const trace = await post('/internal/trace', { id: change.id });
      expect(trace.body.data).toMatchObject({ kind: 'change', change: { change: { status: 'done' } } });
    } finally {
      await app.close();
      fixture.close();
    }
  });

  it('serves the documented CLI protocol end to end', async () => {
    const fixture = createEngineFixture({
      chapters: { 1: chapterText('Начало', ['Тестовый абзац.']), 2: chapterText('Вторая', ['Служебная строка.']) },
    });
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      closeApp = async () => {
        await app.close();
        fixture.close();
      };
      const port = (app.server.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${port}`;

      const job = await cli(url, ['next', '--for', 'fwd']);
      expect(job.code).toBe(0);
      const assignment = JSON.parse(job.stdout) as WriterAssignment;
      expect(assignment).toMatchObject({ pass: 'draft', chapter: 3 });
      expect(assignment.leaseId).toMatch(/^lea_/u);
      expect(assignment.expectation?.chars).toEqual({ min: 20_000, max: 30_000 });

      const beat = await cli(url, ['beat', assignment.leaseId]);
      expect(beat.code).toBe(0);
      expect(JSON.parse(beat.stdout)).toMatchObject({ leaseId: assignment.leaseId });

      // BOOK-62: a prose step declares the pinned model, and `trace` prints it on the step and
      // on both gates — «which model wrote this chapter» without grepping.
      fixture.writeChapterBlocks(3, 'Глава', ['Служебный абзац для проверки объёма страницы.']);
      expect((await cli(url, ['start', assignment.leaseId])).code).toBe(0);
      expect((await cli(url, ['land', assignment.leaseId])).code).toBe(0);
      for (const role of ['editor', 'consultant']) {
        await cli(url, ['next', '--role', role, '--session', `${role}-1`]);
        const answer = await cli(url, [
          'verdict', assignment.stepId, '--role', role, '--session', `${role}-1`, '--verdict', 'HOLDS',
          '--model', PIPELINE_MODEL,
        ]);
        expect(answer.code, answer.stderr).toBe(0);
      }
      const closed = await cli(url, ['done', assignment.leaseId, '--model', PIPELINE_MODEL]);
      expect(closed.code, closed.stderr).toBe(0);
      const stepTrace = await cli(url, ['trace', assignment.stepId]);
      expect(stepTrace.code).toBe(0);
      expect(stepTrace.stdout).toContain('closed');
      expect(stepTrace.stdout.split('\n')[0]).toContain(`model ${PIPELINE_MODEL}`);
      const gateLine = stepTrace.stdout.split('\n').find((row) => row.includes('gates:')) ?? '';
      expect(gateLine).toContain(`editor:HOLDS [${PIPELINE_MODEL}]`);
      expect(gateLine).toContain(`consultant:HOLDS [${PIPELINE_MODEL}]`);

      const pending = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'уточнить абзац' });
      const trace = await cli(url, ['trace', pending.id]);
      expect(trace.code).toBe(0);
      expect(trace.stdout).toContain(`change ${pending.id}`);
      expect(trace.stdout).toContain('cascade: none');

      const reconcile = await cli(url, ['reconcile']);
      expect(reconcile.code).toBe(0);
      expect(JSON.parse(reconcile.stdout)).toMatchObject({ lane: { holder: null } });

      const badLane = await cli(url, ['next', '--for', 'sideways']);
      expect(badLane.code).toBe(2);
      expect(badLane.stderr).toContain('INVALID');

      const missing = await cli(url, ['land']);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain('leaseId is required');
    } finally {
      // `closeApp` closes both; only runs if the listen succeeded.
      if (closeApp === null) {
        await app.close();
        fixture.close();
      }
    }
  });

  it('refuses an intervention without an auditor FITS (BOOK-9)', async () => {
    const fixture = createEngineFixture({
      chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) },
    });
    const identity = upsertIdentity(fixture.db, {
      yandexSub: 'yandex-engine-1',
      displayName: 'Аня',
      at: '2026-10-26T10:00:00Z',
    });
    const seed = (id: string, verdict: string | null, rights: string | null = 'CLEAR'): string => {
      insertComment(fixture.db, {
        id,
        identityId: identity.id,
        chapter: 1,
        blockId: null,
        blockIndex: null,
        baseRev: 1,
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
        createdAt: '2026-10-26T10:01:00Z',
        idemKey: null,
      });
      if (verdict !== null) {
        fixture.db.prepare('UPDATE comments SET audit_verdict = ? WHERE id = ?').run(verdict, id);
      }
      // BOOK-61: the internal queue reads the same three columns acceptance does.
      fixture.db.prepare('UPDATE comments SET rights_verdict = ? WHERE id = ?').run(rights, id);
      return id;
    };
    const unaudited = seed('cmt_01JB7ENGINE000000000000001', null);
    const refusedByAuditor = seed('cmt_01JB7ENGINE000000000000002', 'OFF');
    const fits = seed('cmt_01JB7ENGINE000000000000003', 'FITS');
    // A row the rights gate has not cleared is refused before the auditor is even consulted.
    const noRights = seed('cmt_01JB7ENGINE000000000000004', 'FITS', null);
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    const auth = { authorization: `Bearer ${TOKEN}` };
    try {
      for (const commentId of [unaudited, refusedByAuditor, noRights, 'cmt_missing']) {
        const response = await app.inject({
          method: 'POST',
          url: '/internal/changes',
          headers: auth,
          payload: { kind: 'reader_edit', chapter: 1, intent: 'убрать абзац', commentId },
        });
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({
          code:
            commentId === 'cmt_missing'
              ? 'UNKNOWN_COMMENT'
              : commentId === noRights
                ? 'RIGHTS_REQUIRED'
                : 'AUDIT_REQUIRED',
        });
      }
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });

      const created = await app.inject({
        method: 'POST',
        url: '/internal/changes',
        headers: auth,
        payload: { kind: 'reader_edit', chapter: 1, intent: 'убрать абзац', commentId: fits },
      });
      expect(created.statusCode).toBe(200);
      const source = fixture.db
        .prepare('SELECT source_comment FROM changes WHERE id = ?')
        .get((created.json().data as { id: string }).id);
      expect(source).toEqual({ source_comment: fits });

      // `accept.ts` owns `accepted_comment`: this route may not mint one (it would leave the
      // comment unlinked and allow a second change for the same intervention).
      const reserved = await app.inject({
        method: 'POST',
        url: '/internal/changes',
        headers: auth,
        payload: { kind: 'accepted_comment', chapter: 1, intent: 'убрать абзац', commentId: fits },
      });
      expect(reserved.statusCode).toBe(422);
      expect(reserved.json()).toMatchObject({ code: 'ACCEPTED_COMMENT_RESERVED' });
    } finally {
      await app.close();
      fixture.close();
    }
  });

  it('judges an intent as the kind the comment carries (BOOK-16)', async () => {
    const fixture = createEngineFixture({
      chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) },
    });
    const identity = upsertIdentity(fixture.db, {
      yandexSub: 'yandex-engine-kind',
      displayName: 'Аня',
      at: '2026-10-26T10:00:00Z',
    });
    const commentId = 'cmt_01JB7ENGINEKIND000000000001';
    insertComment(fixture.db, {
      id: commentId,
      identityId: identity.id,
      chapter: 1,
      blockId: null,
      blockIndex: null,
      baseRev: 1,
      quote: null,
      prefix: null,
      suffix: null,
      author: 'Аня',
      body: 'Подписан отказ на пропуск.',
      proposedText: 'Отказ подписан.',
      interventionKind: 'document',
      bodySha: 'b'.repeat(64),
      flags: [],
      ipHash: 'e'.repeat(64),
      status: 'new',
      guard: null,
      reason: null,
      createdAt: '2026-10-26T10:01:00Z',
      idemKey: null,
    });
    fixture.db.prepare(`UPDATE comments SET audit_verdict = 'FITS', rights_verdict = 'CLEAR' WHERE id = ?`).run(commentId);
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    const auth = { authorization: `Bearer ${TOKEN}` };
    const enqueue = (intent: string) =>
      app.inject({
        method: 'POST',
        url: '/internal/changes',
        headers: auth,
        payload: { kind: 'reader_edit', chapter: 1, intent, commentId },
      });
    try {
      // The route reads the kind from the row, so the prose-correction rule reaches it.
      const prose = await enqueue('убрать повтор в абзаце');
      expect(prose.statusCode).toBe(422);
      expect(prose.json()).toMatchObject({ code: 'INTENT_PROSE_CORRECTION' });

      // A kind this build does not know is refused with a code, never accepted as "no kind".
      fixture.db.pragma('ignore_check_constraints = ON');
      fixture.db.prepare('UPDATE comments SET intervention_kind = ? WHERE id = ?').run('signature', commentId);
      fixture.db.pragma('ignore_check_constraints = OFF');
      const unknown = await enqueue('подписан отказ на пропуск');
      expect(unknown.statusCode).toBe(422);
      expect(unknown.json()).toMatchObject({ code: 'INTERVENTION_KIND_UNKNOWN' });

      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });
    } finally {
      await app.close();
      fixture.close();
    }
  });
});
