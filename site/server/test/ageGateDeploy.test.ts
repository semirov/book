/**
 * BOOK-232 — the deploy smoke reads a chapter through the age gate (BOOK-225) instead of assuming it.
 *
 * `/api/chapters/:n`, `/api/history/chapters/:n` and `/book.fb2` answer `403 {"code":"AGE_GATE"}`
 * to a reader who has not answered the 18+ question, so a smoke that only knows "200 or 404
 * NOT_WRITTEN" turns every release red (`GET /api/chapters/1` was the whole failure of the v33
 * deploy) — and a smoke that accepted any 403 would pass a gate that is broken in either direction.
 * The rule these cases pin: the refusal is accepted only when its body names `AGE_GATE`, and then
 * only when the acknowledgement the site itself issues really lifts it — `POST /api/age`, the
 * `book_age` value from the `Set-Cookie` it answered with (never a day computed here, never a guess
 * at the clock), and the same chapter request with that cookie. The gate is never weakened: the
 * cookie is sent by this request only, and no route or config is added that lets a reader skip it.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SITE_ROOT } from '../src/config.ts';
import {
  closeAll,
  envFor,
  fakeDocker,
  gitRoot,
  release,
  serveSite,
  temp,
} from './composeReleaseHarness.ts';

vi.setConfig({ testTimeout: 90_000 });

afterEach(closeAll);

/** One green-path deploy over a site that applies the gate as `gate` says. */
async function deploy(gate: 'on' | 'ignored' | 'other'): Promise<{ code: number | null; out: string; http: string; stateDir: string }> {
  const root = gitRoot();
  const stateDir = temp('book-232-age-');
  const bin = fakeDocker(stateDir);
  const http = join(stateDir, 'http.log');
  writeFileSync(http, '', 'utf8');
  const siteUrl = await serveSite(stateDir, {
    healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) } }),
    gate,
    log: http,
  });
  const result = await release(['--ref', 'HEAD'], {
    ...envFor(root, stateDir, bin, siteUrl),
    FAKE_VOLUME_SCHEMA: '33',
  });
  return { ...result, http: readFileSync(http, 'utf8'), stateDir };
}

describe('BOOK-232: the smoke proves the age gate by its own round trip', () => {
  it('c) 403 without the cookie and 200 with it: the deploy is green, and /api/age was really asked', async () => {
    const result = await deploy('on');

    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('smoke: the age gate is satisfied by its own acknowledgement');
    expect(result.out).toContain('healthy: book:');
    // The mechanism, read from the site's own request log: the chapter was refused, the site was
    // asked for its day, and the SAME request was repeated carrying the cookie it issued.
    const chapter = result.http.split('\n').filter((line) => line.startsWith('GET /api/chapters/1'));
    expect(chapter, result.http).toEqual(['GET /api/chapters/1 age=none', 'GET /api/chapters/1 age=sent']);
    expect(result.http.split('\n').filter((line) => line.startsWith('POST /api/age')), result.http).toHaveLength(1);
    // A green deploy still writes its last-good image: the smoke did not turn the gate into a red.
    expect(readFileSync(join(result.stateDir, 'last-good-image'), 'utf8')).not.toBe('');
  });

  it('d) a gate that refuses even WITH the cookie is red, and the reason names the gate', async () => {
    const result = await deploy('ignored');

    expect(result.code, result.out).toBe(1);
    // Proof that (c) is not "any 403 is fine": the same request with the issued cookie is refused,
    // and the run says which step decided it.
    expect(result.out).toContain('/api/chapters/1 answered 403 AGE_GATE even with the cookie');
    expect(result.out).toContain('FAILED at');
    expect(result.out).not.toContain('healthy:');
    expect(existsSync(join(result.stateDir, 'last-good-image'))).toBe(false);
    // The smoke still went through the acknowledgement: it does not give up on the first 403.
    expect(result.http.split('\n').filter((line) => line.startsWith('POST /api/age')), result.http).toHaveLength(1);
  });

  it('a 403 without the AGE_GATE code is never accepted as the gate', async () => {
    // A site that refuses the prose for some OTHER reason is a red deploy: the smoke decides from the
    // machine-readable code, not from the status. A gate accepted "because it answered 403" would let
    // a broken refusal ship as a green release.
    const result = await deploy('other');

    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('/api/chapters/1 answered 403 without the AGE_GATE code');
    // It does not even try to acknowledge: there is no gate here to satisfy.
    expect(result.http.split('\n').filter((line) => line.startsWith('POST /api/age')), result.http).toHaveLength(0);
    expect(existsSync(join(result.stateDir, 'last-good-image'))).toBe(false);
  });

  it('a catalog that answers 500 is red, even when the body starts like an array', async () => {
    // AC 2 names a 200 for `/api/chapters`; a shape check alone would pass a 500 whose body happens to
    // begin with `[` — the entry point is down and the deploy would have called that healthy.
    const root = gitRoot();
    const stateDir = temp('book-232-age-');
    const bin = fakeDocker(stateDir);
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) } }),
      catalogStatus: 500,
    });

    const result = await release(['--ref', 'HEAD'], { ...envFor(root, stateDir, bin, siteUrl), FAKE_VOLUME_SCHEMA: '33' });

    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('/api/chapters answered 500');
    expect(result.out).not.toContain('healthy:');
  });

  it('the runbook comment states the mechanism the smoke relies on', () => {
    // The deploy's runbook lives in `smoke()`'s comment: the next person reads the refusal and the
    // round trip there, not in a ticket.
    const script = readFileSync(join(SITE_ROOT, 'deploy', 'compose-release.sh'), 'utf8');
    const start = script.search(/^smoke\(\) \{/mu);
    expect(start, 'the smoke is defined at the start of a line').toBeGreaterThan(0);
    const block = script.slice(script.lastIndexOf('# The HTTP reads a browser would notice', start), start);
    expect(block).toContain('POST /api/age');
    expect(block).toContain('book_age=YYYY-MM-DD; Max-Age=31536000; Path=/; SameSite=Lax');
    expect(block).toContain('not signed by design');
    // The comment is wrapped as prose, so the claim is asserted in the two pieces it is written in.
    expect(block).toContain('`/healthz` carries no gate');
    expect(block).toContain('flag today');
    expect(block).toContain('AGE_GATE');
  });
});
