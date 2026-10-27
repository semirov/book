/**
 * Gate B over the session protocol (BOOK-61, BOOK-DOC-42 §5): `engine next --role rights` and
 * `engine verdict --role rights --verdict CLEAR|REFUSED` are the text surface's two calls.
 *
 * The engine's own rules are tested in `rightsSurface.test.ts`; this file proves only the wire —
 * the CLI accepts the conditional role, the route refuses a prose enum offered to it, and a
 * refusal the module cannot print is refused rather than stored. It lives apart from `api.test.ts`
 * because a dispatch is one fact and the protocol file is already long.
 */

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

describe('the rights role on the wire', () => {
  let closeApp: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await closeApp?.();
    closeApp = null;
  });

  it('carries Gate B over the same wire: --role rights is a conditional dispatch', async () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) } });
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    const auth = { authorization: `Bearer ${TOKEN}` };
    try {
      // A chapter whose new prose carries a long quote with no source: Gate B is mandatory.
      fixture.engine.enqueue({ kind: 'operator', chapter: 1, intent: 'переписать абзац' });
      const job = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      fixture.engine.start(job.leaseId);
      fixture.writeChapterBlocks(1, 'Начало', [`«${'чужое слово '.repeat(24).trim()}»`]);
      fixture.engine.land(job.leaseId);

      await app.listen({ host: '127.0.0.1', port: 0 });
      closeApp = async () => {
        await app.close();
        fixture.close();
      };
      const port = (app.server.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${port}`;

      const offered = await cli(url, ['next', '--role', 'rights']);
      expect(offered.code).toBe(0);
      const assignment = JSON.parse(offered.stdout) as { stepId: string; rule: string; role: string };
      expect(assignment).toMatchObject({ role: 'rights', rule: 'RIGHTS-QUOTE' });

      // A rights answer with a prose enum is refused at the route, not silently stored.
      const mismatched = await app.inject({
        method: 'POST',
        url: '/internal/verdict',
        headers: auth,
        payload: { stepId: assignment.stepId, role: 'rights', session: 'rights', verdict: 'HOLDS' },
      });
      expect(mismatched.statusCode).toBe(422);
      expect(mismatched.json()).toMatchObject({ code: 'INVALID_VERDICT' });

      const refused = await cli(url, ['verdict', assignment.stepId, '--role', 'rights', '--verdict', 'REFUSED']);
      // A refusal is the CLI's own exit code (2), not a crash: the engine named the reason.
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain('RIGHTS_RULE_REQUIRED');

      const cleared = await cli(url, ['verdict', assignment.stepId, '--role', 'rights', '--verdict', 'CLEAR']);
      expect(cleared.code).toBe(0);
      expect(JSON.parse(cleared.stdout)).toMatchObject({ verdict: 'CLEAR', closed: false });
      expect(
        fixture.db.prepare(`SELECT role, verdict FROM gate_verdicts WHERE step_id = ?`).get(job.stepId),
      ).toEqual({ role: 'rights', verdict: 'CLEAR' });
    } finally {
      if (closeApp === null) {
        await app.close();
        fixture.close();
      }
    }
  });

});
