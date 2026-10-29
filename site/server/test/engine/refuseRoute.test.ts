/**
 * `POST /internal/refuse` — the refusal's own door (owner's invariant, 2026-10-29).
 *
 * A body names the step exactly once (`leaseId` or `stepId`) and carries the public sentence; the
 * engine answers what it did — the step, the change, and the change's status. A refusal whose
 * restore cannot be made is a `TEXT_STUCK` a session can branch on, never a 500.
 */

import type { WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { buildControl } from '../../src/engine/control.ts';
import { chapterText, createEngineFixture } from './helpers.ts';

const TOKEN = 'test-token';

describe('POST /internal/refuse', () => {
  it('refuses a step over the wire, and says so in the filing’s own words', async () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) } });
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const base = app.server.address();
      if (base === null || typeof base === 'string') throw new Error('no address');
      const url = `http://127.0.0.1:${String(base.port)}`;
      const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
      const post = async (path: string, body: unknown) => {
        const response = await fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
        return { status: response.status, body: (await response.json()) as { ok: boolean; data: unknown; code?: string } };
      };

      const change = fixture.engine.enqueue({ kind: 'operator', chapter: 1, intent: 'среда вместо четверга' });
      const job = (await post('/internal/next', { for: 'fwd', session: 'w1' })).body.data as WriterAssignment;
      await post('/internal/start', { leaseId: job.leaseId });
      fixture.writeChapterBlocks(1, 'Начало', ['Первый абзац.', 'Второй абзац.']);
      await post('/internal/land', { leaseId: job.leaseId });
      const landed = fixture.readChapter(1);

      // One of leaseId|stepId, and a sentence: a body with both (or neither) is a shape refusal.
      expect((await post('/internal/refuse', { because: 'не беру' })).status).toBe(400);
      expect(
        (await post('/internal/refuse', { leaseId: job.leaseId, stepId: job.stepId, because: 'не беру' })).status,
      ).toBe(400);

      const refused = await post('/internal/refuse', {
        leaseId: job.leaseId,
        because: 'не беру: документ не из этой сцены',
      });
      expect(refused.status).toBe(200);
      expect(refused.body.data).toMatchObject({
        stepId: job.stepId,
        changeId: change.id,
        changeStatus: 'void',
        applied: true,
      });
      // The chapter is back to the pre-pass text, and the trace reads the one decision.
      expect(fixture.readChapter(1)).not.toBe(landed);
      expect(fixture.engine.trace(change.id)).toMatchObject({
        kind: 'change',
        change: { change: { status: 'void', outcome: 'dropped', reason: 'не беру: документ не из этой сцены' } },
      });

      // A second refusal of the same step is not a second decision.
      const again = await post('/internal/refuse', { leaseId: job.leaseId, because: 'не беру: снова' });
      expect(again.status).toBe(409);

      // The operator's door names the step instead of a lease: same refusal, same sentence.
      const second = fixture.engine.enqueue({ kind: 'operator', chapter: 1, intent: 'ещё одна правка' });
      const next = (await post('/internal/next', { for: 'fwd', session: 'w2' })).body.data as WriterAssignment;
      const byStep = await post('/internal/refuse', { stepId: next.stepId, because: 'не беру: правка не нужна' });
      expect(byStep.status).toBe(200);
      expect(byStep.body.data).toMatchObject({ stepId: next.stepId, changeId: second.id, changeStatus: 'void' });
    } finally {
      await app.close();
      fixture.close();
    }
  });
});
