import type { WriterAssignment } from '@book/shared';
import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { SITE_ROOT } from '../../src/config.ts';
import { buildControl } from '../../src/engine/control.ts';
import { admitPremise } from '../../src/engine/premise.ts';
import { newChangeId } from '../../src/util/ulid.ts';
import { toIso } from '../../src/util/time.ts';
import { chapterText, createEngineFixture, driveStub, type Fixture } from './helpers.ts';

/**
 * BOOK-117 §4 — `POST /internal/pass`: an operator/session opens a first pass for one named
 * chapter. The draft lanes can only offer their own next slot (`fwd` → 1, `bwd` → the last
 * chapter), so the owner's premise waiting in a late chapter could never be written before
 * dozens of passes ran.
 *
 * No mocks: a real fixture database, the real engine and the real control route. The pass is
 * the *same* scheduler a poll produces — one `openPass`, one step, one lease, one premise.
 */

const TOKEN = 'test-token';
const exec = promisify(execFile);

/** The refusal a call throws, so a test asserts the code the session loop branches on. */
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? 'NO_CODE';
  }
  return 'NO_REFUSAL';
}

function stepCount(fixture: Fixture): { n: number } {
  return fixture.db.prepare('SELECT COUNT(*) AS n FROM steps').get() as { n: number };
}

function leaseOf(fixture: Fixture, stepId: string): { id: string; session: string } | undefined {
  return fixture.db
    .prepare('SELECT id, session FROM leases WHERE step_id = ? AND released_at IS NULL')
    .get(stepId) as { id: string; session: string } | undefined;
}

/** The owner's one real intervention: a premise on an empty chapter, base_rev 0. */
function premiseOn(fixture: Fixture, chapter: number, intent: string): string {
  const id = newChangeId(fixture.clock.now());
  admitPremise(fixture.db, {
    id,
    kind: 'operator',
    chapter,
    intent,
    interventionKind: 'document',
    sourceComment: null,
    sourceSession: null,
    at: toIso(fixture.clock.now()),
  });
  return id;
}

describe('POST /internal/pass — a first pass for one named chapter (BOOK-117 §4)', () => {
  it('validates the chapter it is asked for before anything else', () => {
    const fixture = createEngineFixture();
    try {
      expect(codeOf(() => fixture.engine.openChapterPass(43, 'writer-seed'))).toBe('INVALID_CHAPTER');
      expect(codeOf(() => fixture.engine.openChapterPass(0, 'writer-seed'))).toBe('INVALID_CHAPTER');
      expect(codeOf(() => fixture.engine.openChapterPass(1.5, 'writer-seed'))).toBe('INVALID_CHAPTER');
      expect(stepCount(fixture)).toEqual({ n: 0 });
    } finally {
      fixture.close();
    }
  });

  it('refuses NOT_DRAFTING while the owner’s switch is off, and opens no step', () => {
    const fixture = createEngineFixture({ env: { DRAFTING: 'off' } });
    try {
      expect(codeOf(() => fixture.engine.openChapterPass(40, 'writer-seed'))).toBe('NOT_DRAFTING');
      expect(stepCount(fixture)).toEqual({ n: 0 });
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM leases').get()).toEqual({ n: 0 });
    } finally {
      fixture.close();
    }
  });

  it('opens chapter 40 with its premise on the assignment, not the lane’s next slot', () => {
    const fixture = createEngineFixture();
    try {
      const premiseId = premiseOn(fixture, 40, 'в главе 40 появляется документ о допуске');

      const assignment = fixture.engine.openChapterPass(40, 'writer-seed') as WriterAssignment | null;
      if (!assignment) throw new Error('expected a writer assignment');
      expect(assignment).toMatchObject({
        pass: 'draft',
        chapter: 40,
        premise: { intent: { value: 'в главе 40 появляется документ о допуске', untrusted: true }, kind: 'document' },
        intent: null,
      });
      // A real lease, held by the session that asked for the pass.
      expect(leaseOf(fixture, assignment.stepId)).toMatchObject({ id: assignment.leaseId, session: 'writer-seed' });

      // The named chapter is the one opened: ch01 and ch42 — what the two lanes would offer —
      // are untouched, and the same pass carries the premise row.
      expect(fixture.db.prepare('SELECT chapter, pass, lane, premise_change FROM steps').all()).toEqual([
        { chapter: 40, pass: 'draft', lane: 'backward', premise_change: premiseId },
      ]);
    } finally {
      fixture.close();
    }
  });

  it('refuses CHAPTER_WRITTEN for a chapter that already has prose', () => {
    const fixture = createEngineFixture();
    try {
      fixture.seedChapterBlocks(40, 'Глава 40', ['Пятая глава уже написана.', 'Служебный абзац.']);
      expect(codeOf(() => fixture.engine.openChapterPass(40, 'writer-seed'))).toBe('CHAPTER_WRITTEN');
      expect(stepCount(fixture)).toEqual({ n: 0 });
    } finally {
      fixture.close();
    }
  });

  it('is idempotent for the same session and refuses PASS_LEASED to another one', () => {
    const fixture = createEngineFixture();
    try {
      const first = fixture.engine.openChapterPass(40, 'writer-seed') as WriterAssignment;
      const again = fixture.engine.openChapterPass(40, 'writer-seed') as WriterAssignment;
      expect(again.stepId).toBe(first.stepId);
      expect(again.leaseId).toBe(first.leaseId);
      expect(stepCount(fixture)).toEqual({ n: 1 });

      expect(codeOf(() => fixture.engine.openChapterPass(40, 'writer-other'))).toBe('PASS_LEASED');
      expect(stepCount(fixture)).toEqual({ n: 1 });
      expect(leaseOf(fixture, first.stepId)?.session).toBe('writer-seed');
    } finally {
      fixture.close();
    }
  });

  it('re-issues an unleased open pass instead of refusing it', () => {
    const fixture = createEngineFixture();
    try {
      const first = fixture.engine.openChapterPass(40, 'writer-seed') as WriterAssignment;
      // The session dies: its lease is released by the reaper, the step stays open.
      fixture.clock.advance(fixture.config.leaseTtlMs + 1_000);
      fixture.engine.reap();
      const resumed = fixture.engine.openChapterPass(40, 'writer-next') as WriterAssignment;
      expect(resumed.stepId).toBe(first.stepId);
      expect(resumed.leaseId).not.toBe(first.leaseId);
      expect(leaseOf(fixture, first.stepId)?.session).toBe('writer-next');
    } finally {
      fixture.close();
    }
  });

  it('refuses BUDGET_PAUSED once the day’s money is spent, and opens no step (BOOK-117)', () => {
    const fixture = createEngineFixture({ env: { BOOK_BUDGET_DAY_USD: '0.01' } });
    try {
      fixture.db
        .prepare(
          `INSERT INTO pass_spend (at, day, pass_id, chapter, pass, model, tokens_in, tokens_out, usd, priced)
           VALUES ('2026-10-25T00:30:00Z', '2026-10-25', 'stp_spent', 1, 'draft', 'deepseek/deepseek-v4-pro', 15152, 0, 0.01, 1)`,
        )
        .run();
      expect(codeOf(() => fixture.engine.openChapterPass(40, 'writer-seed'))).toBe('BUDGET_PAUSED');
      expect(stepCount(fixture)).toEqual({ n: 0 });
    } finally {
      fixture.close();
    }
  });

  it('withdraws the step as interrupted when no process capacity is left', () => {
    const fixture = createEngineFixture({ env: { ENGINE_MAX_CONCURRENT_PROCESSES: '1' } });
    try {
      const held = fixture.engine.openChapterPass(40, 'writer-seed');
      expect(held).not.toBeNull();
      // The second pass has no process slot: it is withdrawn, never left as a stranded step.
      expect(fixture.engine.openChapterPass(41, 'writer-other')).toBeNull();
      expect(
        fixture.db.prepare('SELECT chapter, outcome, note FROM steps WHERE chapter = 41').get(),
      ).toEqual({ chapter: 41, outcome: 'interrupted', note: 'no capacity' });
    } finally {
      fixture.close();
    }
  });

  it('settles the premise as applied when the named pass closes through the existing path', () => {
    const fixture = createEngineFixture();
    try {
      const changeId = premiseOn(fixture, 40, 'в главе 40 появляется документ о допуске');
      const assignment = fixture.engine.openChapterPass(40, 'writer-seed') as WriterAssignment;
      const run = driveStub(fixture, assignment, {
        title: 'Глава 40',
        blocks: ['Глава 40 начинается с документа о допуске.', 'Служебный абзац.'],
      });
      expect(run.stepId).toBe(assignment.stepId);
      expect(run.result.outcome).toBe('rewritten');
      expect(fixture.db.prepare('SELECT chapter, outcome FROM steps WHERE step_id = ?').get(assignment.stepId)).toEqual({
        chapter: 40,
        outcome: 'rewritten',
      });
      expect(
        fixture.db.prepare('SELECT status, outcome, reason FROM changes WHERE id = ?').get(changeId),
      ).toEqual({
        status: 'done',
        outcome: 'applied',
        reason: 'вошло в первую редакцию главы 40',
      });
      // A premise is consumed by its pass, never by the FIFO lane.
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM cascades').get()).toEqual({ n: 0 });
    } finally {
      fixture.close();
    }
  });
});

describe('POST /internal/pass — the route', () => {
  it('requires the bearer token and the chapter bounds, and returns the assignment', async () => {
    const fixture = createEngineFixture();
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    try {
      const unauthenticated = await app.inject({
        method: 'POST',
        url: '/internal/pass',
        payload: { chapter: 40, session: 'writer-seed' },
      });
      expect(unauthenticated.statusCode).toBe(401);
      expect(unauthenticated.json()).toMatchObject({ code: 'UNAUTHORIZED' });
      expect(stepCount(fixture)).toEqual({ n: 0 });

      const outOfRange = await app.inject({
        method: 'POST',
        url: '/internal/pass',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { chapter: 43, session: 'writer-seed' },
      });
      expect(outOfRange.statusCode).toBe(400);
      expect(outOfRange.json()).toMatchObject({ code: 'INVALID' });
      expect(stepCount(fixture)).toEqual({ n: 0 });

      // BOOK-166: the route opens a pass only for a filing — the engine's own rule, not a UI one.
      premiseOn(fixture, 40, 'в главе 40 появляется документ о допуске');
      const ok = await app.inject({
        method: 'POST',
        url: '/internal/pass',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { chapter: 40, session: 'writer-seed' },
      });
      expect(ok.statusCode).toBe(200);
      const assignment = ok.json().data as WriterAssignment;
      expect(assignment).toMatchObject({ pass: 'draft', chapter: 40 });
      expect(typeof assignment.stepId).toBe('string');
      expect(typeof assignment.leaseId).toBe('string');

      // The same assignment a second call returns — the route is a pass, not a new pass each time.
      const repeated = await app.inject({
        method: 'POST',
        url: '/internal/pass',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { chapter: 40, session: 'writer-seed' },
      });
      expect(repeated.statusCode).toBe(200);
      expect(repeated.json().data).toMatchObject({ stepId: assignment.stepId, leaseId: assignment.leaseId });

      const squatted = await app.inject({
        method: 'POST',
        url: '/internal/pass',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { chapter: 40, session: 'writer-other' },
      });
      expect(squatted.statusCode).toBe(409);
      expect(squatted.json()).toMatchObject({ code: 'PASS_LEASED' });

      const noSession = await app.inject({
        method: 'POST',
        url: '/internal/pass',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { chapter: 41, session: '' },
      });
      expect(noSession.statusCode).toBe(400);
      expect(stepCount(fixture)).toEqual({ n: 1 });
    } finally {
      await app.close();
      fixture.close();
    }
  });

  it('serves the pass as the premise it is: chapter 40 with the owner’s intent', async () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) } });
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    try {
      premiseOn(fixture, 40, 'в главе 40 появляется документ о допуске');
      const response = await app.inject({
        method: 'POST',
        url: '/internal/pass',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { chapter: 40, session: 'writer-seed' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({
        pass: 'draft',
        chapter: 40,
        premise: { intent: { value: 'в главе 40 появляется документ о допуске', untrusted: true }, kind: 'document' },
      });
      // Chapter 1 is written, so the forward lane's next slot is 2 — and it was not opened here.
      expect(fixture.db.prepare('SELECT chapter FROM steps').all()).toEqual([{ chapter: 40 }]);
    } finally {
      await app.close();
      fixture.close();
    }
  });
});

describe('engine.mjs pass — the CLI against a live control app', () => {
  it('opens the named pass, prints the same assignment as `next`, and follows the file’s exit codes', async () => {
    const fixture = createEngineFixture();
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address() as AddressInfo;
      const env = {
        ...process.env,
        ENGINE_URL: `http://127.0.0.1:${address.port}`,
        ENGINE_TOKEN: TOKEN,
        ENGINE_SESSION: 'writer-cli',
      };
      const run = (args: string[]) => exec('node', ['bin/engine.mjs', ...args], { cwd: SITE_ROOT, env });

      const { stdout, stderr } = await run(['pass', '--chapter', '40', '--session', 'writer-cli']);
      expect(stderr).toBe('');
      const assignment = JSON.parse(stdout) as WriterAssignment;
      expect(assignment).toMatchObject({ pass: 'draft', chapter: 40 });
      expect(fixture.db.prepare('SELECT chapter FROM steps').all()).toEqual([{ chapter: 40 }]);
      expect(leaseOf(fixture, assignment.stepId)?.session).toBe('writer-cli');

      // Without `--session` a pass names itself, so a rerun from the same operator stays idempotent.
      const bare = { ...env } as Record<string, string | undefined>;
      delete bare.ENGINE_SESSION;
      const defaulted = await exec('node', ['bin/engine.mjs', 'pass', '--chapter', '41'], { cwd: SITE_ROOT, env: bare });
      const second = JSON.parse(defaulted.stdout) as WriterAssignment;
      expect(second).toMatchObject({ pass: 'draft', chapter: 41 });
      expect(leaseOf(fixture, second.stepId)?.session).toBe('pass-41');

      // A refusal is a code plus exit 2; a malformed command is exit 1 — the file's convention.
      const refused = (await run(['pass', '--chapter', '40', '--session', 'writer-other']).catch(
        (error: unknown) => error,
      )) as { code?: number; stderr?: string };
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain('PASS_LEASED');

      const malformed = (await run(['pass', '--chapter', '43']).catch((error: unknown) => error)) as {
        code?: number;
        stderr?: string;
      };
      expect(malformed.code).toBe(1);
      expect(malformed.stderr).toContain('--chapter 1..42 is required');
    } finally {
      await app.close();
      fixture.close();
    }
  });
});
