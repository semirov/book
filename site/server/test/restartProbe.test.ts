/**
 * BOOK-119 — the restart probe, against a real local HTTP server.
 *
 * The deploy's health logic used to live in bash and could not be tested; it also turned a
 * slow boot on a loaded box into a rollback that restarted the same commit. Here the loop is
 * exercised end to end: a 200 with the expected identity is fast, the same 200 arriving after
 * the budget is late, the previous build answering is stale, nothing answering is fail — and
 * the cadence is the 200 ms the log claims.
 */

import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadReport,
  main,
  parseLoadavg,
  probe,
  readLoad,
  sameCommit,
  waitForHealth,
} from '../../scripts/restart-probe.mjs';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

type Handler = (request: { at: number }) => { status: number; body: unknown };

/** A real server on a random port; records when each request arrived. */
async function serve(handler: Handler): Promise<{ url: string; times: number[] }> {
  const times: number[] = [];
  const server = createServer((_request, response) => {
    const at = Date.now();
    times.push(at);
    const answer = handler({ at });
    response.writeHead(answer.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer.body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the test server has no port');
  return { url: `http://127.0.0.1:${address.port}/healthz`, times };
}

const OK = (commit: string): { status: number; body: unknown } => ({ status: 200, body: { ok: true, commit } });

describe('waitForHealth', () => {
  it('reports a fast success when the new commit answers inside the budget', async () => {
    const { url } = await serve(() => OK('new1234'));
    const since = Date.now();
    const result = await waitForHealth({ url, since, budgetMs: 2_000, graceMs: 500, expectCommit: 'new1234' });
    expect(result).toMatchObject({ health: 'fast', commit: 'new1234' });
    expect(result.polls).toBeGreaterThan(0);
    expect(result.ms).toBeLessThan(1_500);
  });

  it('reports a late success when the 200 arrives inside the grace, not the budget', async () => {
    const readyAt = Date.now() + 900;
    const { url } = await serve(({ at }) => (at >= readyAt ? OK('new1234') : { status: 503, body: { ok: false } }));
    const since = Date.now();
    const result = await waitForHealth({ url, since, budgetMs: 400, graceMs: 3_000, expectCommit: 'new1234' });
    expect(result.health).toBe('late');
    expect(result.commit).toBe('new1234');
    expect(result.ms).toBeGreaterThanOrEqual(700);
  });

  it('reports stale when the previous build answers instead of the new one', async () => {
    const { url } = await serve(() => OK('prev000'));
    const since = Date.now();
    const result = await waitForHealth({
      url,
      since,
      budgetMs: 300,
      graceMs: 400,
      expectCommit: 'new1234',
      prevCommit: 'prev000',
    });
    expect(result).toMatchObject({ health: 'stale', commit: 'prev000' });
  });

  it('fails only after the budget and the grace are both spent', async () => {
    const { url } = await serve(() => ({ status: 503, body: { ok: false } }));
    const since = Date.now();
    const result = await waitForHealth({ url, since, budgetMs: 400, graceMs: 300, expectCommit: 'new1234' });
    expect(result.health).toBe('fail');
    expect(result.ms).toBeGreaterThanOrEqual(650);
  });

  it('reports an identity mismatch as fail when no previous commit is known', async () => {
    const { url } = await serve(() => OK('other000'));
    const result = await waitForHealth({
      url,
      since: Date.now(),
      budgetMs: 300,
      graceMs: 300,
      expectCommit: 'new1234',
    });
    expect(result).toMatchObject({ health: 'fail', commit: 'other000' });
  });

  it('polls at the 200 ms cadence the log claims', async () => {
    const { url, times } = await serve(() => ({ status: 503, body: { ok: false } }));
    await waitForHealth({ url, since: Date.now(), budgetMs: 900, graceMs: 0, expectCommit: 'new1234' });
    expect(times.length).toBeGreaterThanOrEqual(3);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(180);
    }
  });

  it('carries the answer’s own moment, so the caller can subtract a baseline', async () => {
    const { url } = await serve(() => OK('new1234'));
    const since = Date.now();
    const result = await waitForHealth({ url, since, budgetMs: 2_000, graceMs: 200, expectCommit: 'new1234' });
    expect(result.at, 'a healthy answer has a stamp').toBeGreaterThanOrEqual(since);
    expect(result.at).toBeLessThanOrEqual(Date.now());
  });

  it('has no stamp when nothing answered — the downtime is then unknown, not zero', async () => {
    const { url } = await serve(() => ({ status: 503, body: { ok: false } }));
    const result = await waitForHealth({ url, since: Date.now(), budgetMs: 300, graceMs: 100, expectCommit: 'new1234' });
    expect(result).toMatchObject({ health: 'fail', at: 0 });
  });
});

/** `main` prints its `key=value` contract to stdout — that text is what bash reads. */
async function run(argv: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  try {
    return { code: await main(argv), lines };
  } finally {
    log.mockRestore();
  }
}

describe('the CLI contract the deploy reads', () => {
  it('prints `at` on the baseline: the last answer before the restart, 0 when down', async () => {
    const up = await serve(() => OK('prev000'));
    const before = Date.now();
    const baseline = await run(['baseline', '--url', up.url]);
    expect(baseline.code).toBe(0);
    const line = baseline.lines[0] ?? '';
    expect(line).toContain('probe=up');
    const at = Number(/at=(\d+)/u.exec(line)?.[1] ?? '0');
    expect(at, 'a 200 has a real moment').toBeGreaterThanOrEqual(before);

    // A closed port: the site was already down, and the deploy must not blame itself for it.
    const down = await run(['baseline', '--url', 'http://127.0.0.1:9/healthz']);
    expect(down.code).toBe(1);
    expect(down.lines[0]).toContain('probe=down');
    expect(down.lines[0]).toContain('at=0');
  });

  it('prints `first_at` on the wait, so `restart_ms` is the site’s downtime and not the poll window', async () => {
    const { url } = await serve(() => OK('new1234'));
    const since = Date.now();
    const wait = await run(['wait', '--url', url, '--since', String(since), '--budget-ms', '2000', '--expect-commit', 'new1234']);
    expect(wait.code).toBe(0);
    expect(wait.lines).toContain('health=fast');
    const first = Number(wait.lines.find((line) => line.startsWith('first_at='))?.slice('first_at='.length));
    expect(first, 'the first 200 after the restart').toBeGreaterThanOrEqual(since);
    expect(first).toBeLessThanOrEqual(Date.now());
  });
});

describe('probe', () => {
  it('answers `down` for a closed port instead of throwing', async () => {
    const result = await probe('http://127.0.0.1:9/healthz', { timeoutMs: 300 });
    expect(result.status).toBe(0);
    expect(result.body).toBeNull();
  });
});

describe('the load guard numbers', () => {
  it('parses sysctl loadavg output', () => {
    expect(parseLoadavg('{ 1.84 2.05 2.10 }')).toBe(1.84);
    expect(parseLoadavg('{ 37.2 30.1 20.0 }')).toBe(37.2);
    expect(parseLoadavg('not a load average')).toBeNull();
  });

  it('prints one key=value line and decides `above` against the threshold', () => {
    expect(loadReport({ load: 4, cores: 10, perCore: 0.4 })).toBe('load=4.00 cores=10 per_core=0.40 above=0');
    expect(loadReport({ load: 45, cores: 10, perCore: 4.5 }, 2)).toBe('load=45.00 cores=10 per_core=4.50 above=1');
    expect(loadReport({ load: 20, cores: 10, perCore: 2 }, 2)).toBe('load=20.00 cores=10 per_core=2.00 above=0');
    expect(loadReport({ load: null, cores: null, perCore: null })).toBe(
      'load=unknown cores=unknown per_core=unknown above=0',
    );
  });

  it('reads the box, and says `unknown` on a platform without sysctl', () => {
    const values: Record<string, string> = { 'vm.loadavg': '{ 3.00 2.00 1.00 }', 'hw.ncpu': '10\n' };
    const exec = (_file: string, args: string[]): string => values[args[1] ?? ''] ?? '';
    expect(readLoad({ exec })).toEqual({ load: 3, cores: 10, perCore: 0.3 });
    const failing = (): string => {
      throw new Error('sysctl: not found');
    };
    expect(readLoad({ exec: failing })).toEqual({ load: null, cores: null, perCore: null });
  });
});

describe('identity matching', () => {
  it('accepts an abbreviated report of the expected commit', () => {
    expect(sameCommit('552de6c', '552de6c')).toBe(true);
    expect(sameCommit('552de6c', '552de6c1234567890')).toBe(true);
    expect(sameCommit('552de6c1234567890', '552de6c')).toBe(true);
    expect(sameCommit('552de6c', 'ffffff0')).toBe(false);
    expect(sameCommit(null, '552de6c')).toBe(false);
    expect(sameCommit('552de6c', null)).toBe(false);
  });
});
