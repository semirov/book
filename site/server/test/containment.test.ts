import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createFixture } from './helpers.ts';

/**
 * F023 — support-file containment (ARCHITECTURE.md §13.4, §6E.3).
 *
 * The build half lives in `scripts/arch.mjs` (no line of a support file reaches `web/dist`).
 * This is the route half: whatever path a scanner tries, the site answers with the shell or a
 * 404 — never with a dossier, a prompt, a plan or a manuscript file. The canaries are
 * nonsense strings, so a match cannot be a coincidence.
 */
const CANARY = 'КАРТОЧКА-ПЕРСОНАЖА-7f3a9c';
const PROMPT_CANARY = 'ПОДСКАЗКА-ПИСАТЕЛЮ-2b81de';
const MANUSCRIPT_CANARY = 'РУКОПИСЬ-НЕ-ДЛЯ-СЕТИ-94ac17';

const ABOUT =
  'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.';

describe('F023 — no support file is served (§6E.3)', () => {
  let app: FastifyInstance | null = null;
  let cleanup: (() => void) | null = null;

  async function boot(): Promise<FastifyInstance> {
    const fixture = createFixture({
      '00-front.md': `Без названия\n\n${ABOUT}\n`,
      'ch01.md': `Тестовая глава\n\n${MANUSCRIPT_CANARY} стоит здесь.\n`,
    });
    mkdirSync(join(fixture.root, 'bible'), { recursive: true });
    mkdirSync(join(fixture.root, 'process'), { recursive: true });
    writeFileSync(join(fixture.root, 'bible', 'dossiers.md'), `# Досье\n\n${CANARY}\n`, 'utf8');
    writeFileSync(join(fixture.root, 'process', 'ROLE_PROMPTS.md'), `# Роли\n\n${PROMPT_CANARY}\n`, 'utf8');
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

    const webDist = mkdtempSync(join(tmpdir(), 'book-web-'));
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>книга</title>', 'utf8');
    app = await buildApp({
      config: loadConfig({ BOOK_ROOT: fixture.root, DATA_DIR: fixture.dataDir, WEB_DIST: webDist }),
      db: fixture.db,
      state: new StateService(fixture.db),
      version: 'test',
      logger: false,
    });
    cleanup = () => {
      fixture.close();
      rmSync(webDist, { recursive: true, force: true });
    };
    return app;
  }

  it('answers a support path with the shell, never with the file', async () => {
    try {
      const running = await boot();
      for (const url of [
        '/bible/dossiers.md',
        '/process/ROLE_PROMPTS.md',
        '/manuscript/ch01.md',
        '/manuscript/00-front.md',
        '/config/imprint.json',
        '/opencode.json',
        '/.env',
      ]) {
        const response = await running.inject({ method: 'GET', url });
        const body = response.body;
        expect(body, `a dossier leaked at ${url}`).not.toContain(CANARY);
        expect(body, `a prompt leaked at ${url}`).not.toContain(PROMPT_CANARY);
        expect(body, `the manuscript leaked at ${url}`).not.toContain(MANUSCRIPT_CANARY);
        expect([200, 404]).toContain(response.statusCode);
      }
    } finally {
      await app?.close();
      app = null;
      cleanup?.();
    }
  });

  it('still serves the book through the API, so containment is not a blackout', async () => {
    try {
      const running = await boot();
      const chapter = await running.inject({ method: 'GET', url: '/api/chapters/1' });
      expect(chapter.statusCode).toBe(200);
      expect(chapter.body).toContain('Тестовая глава');
      expect(chapter.body).toContain(MANUSCRIPT_CANARY);
    } finally {
      await app?.close();
      app = null;
      cleanup?.();
    }
  });
});
