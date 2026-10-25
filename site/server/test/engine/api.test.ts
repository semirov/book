import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { WriterAssignment } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { SITE_ROOT } from '../../src/config.ts';
import { buildControl } from '../../src/engine/control.ts';
import { chapterText, createEngineFixture } from './helpers.ts';

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

  it('admits a change, hands out the job, and refuses the ending', async () => {
    const fixture = createEngineFixture({
      chapters: { 1: chapterText('Начало', ['Половик намок.']), 67: chapterText('Финал', ['Свет погас.']) },
    });
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    const auth = { authorization: `Bearer ${TOKEN}` };
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/internal/changes',
        headers: auth,
        payload: { kind: 'accepted_comment', chapter: 1, intent: 'убрать половик' },
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

      const ending = await app.inject({
        method: 'POST',
        url: '/internal/changes',
        headers: auth,
        payload: { kind: 'reader_edit', chapter: 67, intent: 'пусть кто-то спасётся' },
      });
      expect(ending.statusCode).toBe(422);
      expect(ending.json()).toMatchObject({ code: 'ENDING_FROZEN' });

      const invalid = await app.inject({
        method: 'POST',
        url: '/internal/changes',
        headers: auth,
        payload: { kind: 'accepted_comment', chapter: 1, intent: '' },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ code: 'INVALID' });
    } finally {
      await app.close();
      fixture.close();
    }
  });

  it('carries one step through the whole session protocol', async () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Половик намок.']) } });
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
      const change = (await post('/internal/changes', { kind: 'accepted_comment', chapter: 1, intent: 'среда' })).body
        .data as { id: string };
      const job = (await post('/internal/next', { for: 'fwd', session: 'w1' })).body.data as WriterAssignment;
      expect((await post('/internal/start', { leaseId: job.leaseId })).status).toBe(200);

      fixture.writeChapterBlocks(1, 'Начало', ['Половик намок в среду.']);
      const landed = await post('/internal/land', { leaseId: job.leaseId });
      expect(landed.body.data).toMatchObject({ landed: true, changed: true, revAfter: 1 });

      expect((await post('/internal/next', { role: 'editor', session: 'editor-1' })).status).toBe(200);
      const editor = await post('/internal/verdict', {
        stepId: job.stepId,
        role: 'editor',
        session: 'editor-1',
        verdict: 'HOLDS',
        findings: [],
      });
      expect(editor.body.data).toMatchObject({ action: 'close', verdict: 'HOLDS' });
      expect((await post('/internal/next', { role: 'consultant', session: 'consultant-1' })).status).toBe(200);
      const consultant = await post('/internal/verdict', {
        stepId: job.stepId,
        role: 'consultant',
        session: 'consultant-1',
        verdict: 'HOLDS',
        findings: [],
      });
      expect(consultant.status).toBe(200);
      const done = await post('/internal/done', { leaseId: job.leaseId, seams: [], note: 'готово' });
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
      chapters: { 1: chapterText('Начало', ['Половик намок.']), 2: chapterText('Вторая', ['Двор был пуст.']) },
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

      const pending = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'уточнить половик' });
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
});
