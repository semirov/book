import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FRAME_FIRST_SENTENCE, TOTAL_CHAPTERS, type AuthorsDto } from '@book/shared';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { tokenMatches } from '../src/http/routes/admin.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { IntegrityReport } from '../src/integrity/service.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createFixture, longProse, type Fixture } from './helpers.ts';

const ABOUT =
  'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.';
const FRONT = `Без названия\n\n${ABOUT}\n`;

async function boot(options: {
  chapters?: Record<string, string>;
  token?: string;
  env?: Record<string, string>;
}): Promise<{ fixture: Fixture; app: FastifyInstance }> {
  const fixture = createFixture({ '00-front.md': FRONT, ...(options.chapters ?? {}) });
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
  const app = await buildApp({
    config: loadConfig({ BOOK_ROOT: fixture.root, DATA_DIR: fixture.dataDir, ...(options.env ?? {}) }),
    db: fixture.db,
    state: new StateService(fixture.db),
    version: 'test',
    logger: false,
    adminToken: options.token ?? '',
  });
  return { fixture, app };
}

describe('the admin token compare (§17)', () => {
  it('matches only the exact token, and never an empty expectation', () => {
    expect(tokenMatches('s3cret', 's3cret')).toBe(true);
    expect(tokenMatches('s3cret', 's3cres')).toBe(false);
    expect(tokenMatches('s3cret', 's3cre')).toBe(false); // a prefix is not a match
    expect(tokenMatches('s3cret', 's3crett')).toBe(false);
    expect(tokenMatches('s3cret', '')).toBe(false);
    expect(tokenMatches('', '')).toBe(false); // no configured token = no access at all
  });
});

describe('the integrity panel (§13.4 point 5, §17)', () => {
  it('does not exist when no admin token is configured: a forgotten secret closes it', async () => {
    const { fixture, app } = await boot({ token: '' });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/admin/integrity' });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
      fixture.close();
    }
  });

  it('refuses a wrong token, a prefix of the right one, and never says what the right one is', async () => {
    const { fixture, app } = await boot({ token: 'right-token' });
    try {
      const missing = await app.inject({ method: 'GET', url: '/api/admin/integrity' });
      expect(missing.statusCode).toBe(401);
      expect(missing.json()).toMatchObject({ code: 'UNAUTHORIZED' });

      for (const guess of ['wrong-token', 'right-toke', 'right-token ']) {
        const response = await app.inject({
          method: 'GET',
          url: '/api/admin/integrity',
          headers: { 'x-admin-token': guess },
        });
        // A trailing space is trimmed, so that one is the token; every other guess is not.
        expect(response.statusCode).toBe(guess === 'right-token ' ? 200 : 401);
      }
    } finally {
      await app.close();
      fixture.close();
    }
  });

  it('reports chapters, the legal gate, the validator and the ungated list', async () => {
    const { fixture, app } = await boot({
      token: 'right-token',
      chapters: {
        'ch01.md': longProse([`${FRAME_FIRST_SENTENCE} Первый абзац главы.`]),
        'ch02.md': longProse(['Второй абзац.']),
      },
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/integrity',
        headers: { authorization: 'Bearer right-token' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as IntegrityReport;

      expect(body.chapters).toMatchObject({ written: 2, total: TOTAL_CHAPTERS });
      expect(body.chapters.totalChars).toBeGreaterThan(0);
      // F007: a 6 500-character chapter is thin, and the panel says which ones.
      expect(body.chapters.thin).toEqual([1, 2]);

      expect(body.legal).toMatchObject({
        denylistVersion: 2,
        persons: 4,
        characters: 4,
        organisations: 3,
        patterns: 2,
        problems: [],
      });
      expect(body.validator).toMatchObject({ errors: 0, passed: true });
      expect(body.attribution.unattributed).toBe(2);
      expect(body.ungated).toEqual([]);
      expect(body.restores).toMatchObject({ total: 0 });
      expect(body.reconciles).toEqual([]);
    } finally {
      await app.close();
      fixture.close();
    }
  });

  it('reports sentence drift and logs one line per drifted block (ADR-044)', async () => {
    const { fixture, app } = await boot({
      token: 'right-token',
      chapters: { 'ch02.md': longProse(['Второй абзац.']) },
    });
    const driftKeys = (): number =>
      (fixture.db.prepare(`SELECT COUNT(*) AS n FROM meta WHERE k LIKE 'sentences.drift:%'`).get() as { n: number }).n;
    const report = async (): Promise<IntegrityReport> => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/integrity',
        headers: { authorization: 'Bearer right-token' },
      });
      expect(response.statusCode).toBe(200);
      return response.json() as IntegrityReport;
    };
    try {
      // The book the ingest published has sentences for every live block, and they agree.
      const clean = await report();
      expect(clean.segmentDrift.blocks).toBeGreaterThan(0);
      expect(clean.segmentDrift.drifted).toBe(0);
      expect(driftKeys()).toBe(0);

      // One stored span moves behind the table's back: the check reports it, once.
      const sentence = fixture.db
        .prepare('SELECT id FROM sentences ORDER BY block_id, idx LIMIT 1')
        .get() as { id: string };
      fixture.db.prepare('UPDATE sentences SET start = start + 1 WHERE id = ?').run(sentence.id);
      const corrupted = (fixture.db.prepare('SELECT start FROM sentences WHERE id = ?').get(sentence.id) as {
        start: number;
      }).start;

      expect((await report()).segmentDrift.drifted).toBe(1);
      expect(driftKeys()).toBe(1);
      // The report reads the rows: a second call adds no second line and repairs nothing.
      expect((await report()).segmentDrift.drifted).toBe(1);
      expect(driftKeys()).toBe(1);
      expect(fixture.db.prepare('SELECT start FROM sentences WHERE id = ?').get(sentence.id)).toEqual({ start: corrupted });
    } finally {
      await app.close();
      fixture.close();
    }
  });

  it('shows a restore as ungated and counts it under attribution, before reconcile', async () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    const first = longProse(['Первый абзац главы.']);
    fixture.write('ch01.md', first);
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    const app = await buildApp({
      config: loadConfig({ BOOK_ROOT: fixture.root, DATA_DIR: fixture.dataDir }),
      db: fixture.db,
      state: new StateService(fixture.db),
      version: 'test',
      logger: false,
      adminToken: 'right-token',
    });
    try {
      fixture.write('ch01.md', longProse(['Первый абзац главы.', 'Второй абзац главы.']));
      reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
      fixture.write('ch01.md', first);
      reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/integrity',
        headers: { 'x-admin-token': 'right-token' },
      });
      const body = response.json() as IntegrityReport;
      expect(body.ungated).toEqual([{ chapter: 1, rev: 3, at: expect.any(String), restoredRev: 1 }]);
      expect(body.restores.total).toBe(1);
      // Three revisions have no lease behind them: the first sighting, the hand edit and
      // the restore — F015 reports all three rather than crediting them to a change.
      expect(body.attribution.unattributed).toBe(3);
    } finally {
      await app.close();
      fixture.close();
    }
  });

  it('says so when the denylist has no teeth instead of showing a green gate', async () => {
    const { fixture, app } = await boot({ token: 'right-token' });
    const empty = join(fixture.root, 'empty-denylist.json');
    writeFileSync(
      empty,
      JSON.stringify({ version: 1, persons: [], characters: [], organisations: [], patterns: [] }),
      'utf8',
    );
    await app.close();
    const second = await boot({ token: 'right-token', env: { DENYLIST_PATH: empty } });
    try {
      const response = await second.app.inject({
        method: 'GET',
        url: '/api/admin/integrity',
        headers: { 'x-admin-token': 'right-token' },
      });
      const body = response.json() as IntegrityReport;
      expect(body.legal.persons).toBe(0);
      expect(body.legal.problems.join(' ')).toMatch(/cannot catch a real name/u);
    } finally {
      await second.app.close();
      second.fixture.close();
      fixture.close();
    }
  });

  it('serves the end matter over HTTP: one author, deterministic and measured once', async () => {
    const { fixture, app } = await boot({ token: 'right-token', chapters: { 'ch01.md': longProse(['Абзац.']) } });
    try {
      const first = await app.inject({ method: 'GET', url: '/api/authors' });
      expect(first.statusCode).toBe(200);
      // BOOK-109: the app's one policy owns freshness; the end matter answers `no-store`.
      expect(first.headers['cache-control']).toBe('no-store');
      const firstBody = first.json() as AuthorsDto;

      const second = await app.inject({ method: 'GET', url: '/api/authors' });
      expect(second.json()).toEqual(firstBody);

      expect(firstBody.author).toMatchObject({ label: 'Филипп Семиров', share: 1 });
      expect(firstBody.contributors).toEqual([]);
      expect(firstBody.sum).toBeLessThanOrEqual(1);
    } finally {
      await app.close();
      fixture.close();
    }
  });

  it('reports a missing denylist as a gate that cannot run, never as a pass', async () => {
    const { fixture, app } = await boot({ token: 'right-token', env: { DENYLIST_PATH: '/nonexistent/denylist.json' } });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/integrity',
        headers: { 'x-admin-token': 'right-token' },
      });
      const body = response.json() as IntegrityReport;
      expect(body.legal.denylistVersion).toBeNull();
      expect(body.legal.problems.join(' ')).toMatch(/legal gate cannot run/u);
      expect(body.validator.errors).toBeGreaterThan(0);
      expect(body.validator.passed).toBe(false);
    } finally {
      await app.close();
      fixture.close();
    }
  });
});
