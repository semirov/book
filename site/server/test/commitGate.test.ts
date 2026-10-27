import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { FRAME_FIRST_SENTENCE } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { SITE_ROOT, loadConfig } from '../src/config.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { buildControl } from '../src/engine/control.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { listUngated } from '../src/integrity/ungated.ts';
import { createEngineFixture } from './engine/helpers.ts';
import { createFixture } from './helpers.ts';

const exec = promisify(execFile);

/**
 * A child `node` must not inherit the coverage collector: vitest's v8 provider hands
 * `NODE_V8_COVERAGE` to the workers, and a subprocess writing into the same temp directory
 * races the reporter that cleans it. The tool is unaffected; only the instrumentation goes.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  return env;
}

/** The real gate, run as the hook runs it: `node site/bin/validate.mjs`. */
async function validate(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await exec('node', ['bin/validate.mjs', ...args], {
      cwd: SITE_ROOT,
      env: childEnv(),
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

const ABOUT =
  'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.';

const FRONT = `Без названия\n\n${ABOUT}\n`;

function prose(body: string): string {
  const filler =
    'Служебный абзац для проверки объёма. Это предложение повторяется, чтобы набрать нужную длину, и не является текстом книги. ' +
    'Служебный абзац для проверки объёма. Это предложение повторяется, чтобы набрать нужную длину, и не является текстом книги.';
  let text = body;
  while (text.length < 6_000) text += `\n\n${filler}`;
  return `Тестовая глава\n\n${text}\n`;
}

describe('the commit gate, run as the hook runs it (§13.4 point 3, §20 M7)', () => {
  it('rejects a synthetic commit that names a denylisted real person', async () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      fixture.write(
        'ch09.md',
        prose('Вчера Владимир Путин приехал в город.'),
      );
      const result = await validate([`--root=${fixture.root}`]);
      expect(result.code).toBe(1);
      expect(result.out).toMatch(/F005 error ch09\.md/u);
      expect(result.out).toMatch(/denylisted person: «Владимир Путин»/u);
    } finally {
      fixture.close();
    }
  });

  it('rejects a protected character and an illegal-content pattern', async () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      fixture.write('ch09.md', prose('Гарри Поттер стоял здесь.'));
      const character = await validate([`--root=${fixture.root}`]);
      expect(character.code).toBe(1);
      expect(character.out).toMatch(/protected character: «Гарри Поттер»/u);

      fixture.write(
        'ch09.md',
        prose('Он записал рецепт: метамфетамин.'),
      );
      const pattern = await validate([`--root=${fixture.root}`]);
      expect(pattern.code).toBe(1);
      expect(pattern.out).toMatch(/illegal-content pattern/u);
    } finally {
      fixture.close();
    }
  });

  it('lets an invented name through — no rule polices a name', async () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      fixture.write('ch09.md', prose('Тестовый абзац поднял Тестов Тестович, сторож с ночной смены.'));
      const result = await validate([`--root=${fixture.root}`]);
      expect(result.code).toBe(0);
      expect(result.out).not.toMatch(/F019/u);
      expect(result.out).toMatch(/0 errors/u);
    } finally {
      fixture.close();
    }
  });

  it('rejects a chapter with no title line (F022) and still lets the site ingest it', async () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      // No title line: line 1 is prose, so F022 is an error for the commit, not for the reader.
      // Line 1 is empty: the file has no title line at all, which is F022 (§6C.3).
      fixture.write('ch09.md', `\n${prose('Второй абзац.')}`);
      const result = await validate([`--root=${fixture.root}`]);
      expect(result.code).toBe(1);
      expect(result.out).toMatch(/F022 error ch09\.md/u);

      // The site ingests the same file without asking the validator (§13.4 point 5).
      reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
      const row = fixture.db.prepare('SELECT title, chars FROM chapters WHERE n = 9').get() as {
        title: string | null;
        chars: number;
      };
      expect(row.title).toBeNull();
      expect(row.chars).toBeGreaterThan(0);

      // F022 is a gate for the commit, not a reader gate: the page still serves the chapter.
      const app = await buildApp({
        config: loadConfig({ BOOK_ROOT: fixture.root, DATA_DIR: fixture.dataDir }),
        db: fixture.db,
        state: new StateService(fixture.db),
        version: 'test',
        logger: false,
      });
      try {
        const served = await app.inject({ method: 'GET', url: '/api/chapters/9' });
        expect(served.statusCode).toBe(200);
        expect(served.json()).toMatchObject({ n: 9, title: null });
      } finally {
        await app.close();
      }
    } finally {
      fixture.close();
    }
  });

  it('rejects a written chapter under the 1 600 floor (F007) and exempts a basis-only slot', async () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      // ch01 holds only its frozen frame: no length, no finding (§BOOK-6).
      fixture.write('ch01.md', FRAME_FIRST_SENTENCE);
      fixture.write('ch09.md', `Тестовая глава\n\n${'а'.repeat(900)}\n`);

      const result = await validate([`--root=${fixture.root}`]);
      expect(result.code).toBe(1);
      expect(result.out).toMatch(/F007 error ch09\.md/u);
      expect(result.out).toMatch(/900 characters, the minimum is 1600/u);
      expect(result.out).toMatch(/1 errors/u);
      // The exemption is real, not a silence: ch01 is read and passes.
      expect(result.out).not.toMatch(/ch01\.md/u);
    } finally {
      fixture.close();
    }
  });

  it('emits machine-readable findings for CI', async () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      fixture.write('ch09.md', prose('Владимир Путин приехал в город.'));
      const result = await validate([`--root=${fixture.root}`, '--json']);
      expect(result.code).toBe(1);
      const parsed = JSON.parse(result.out) as { errors: number; findings: Array<{ rule: string }> };
      expect(parsed.errors).toBeGreaterThan(0);
      expect(parsed.findings.map((finding) => finding.rule)).toContain('F005');
    } finally {
      fixture.close();
    }
  });
});

describe('`reconcile <chapter>` over the internal API (§13.3)', () => {
  it('refuses a chapter that is not ungated, and still answers the maintenance pass', async () => {
    const fixture = createEngineFixture();
    const app = await buildControl({ engine: fixture.engine, token: 'test-token', logger: false });
    try {
      const call = async (body: unknown) => {
        const response = await app.inject({
          method: 'POST',
          url: '/internal/reconcile',
          headers: { authorization: 'Bearer test-token' },
          payload: body as Record<string, unknown>,
        });
        return { status: response.statusCode, body: response.json() as Record<string, unknown> };
      };

      // No restore yet: the mark is refused, and says why.
      const refused = await call({ chapter: 1, because: 'restore rev 1' });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'NOT_UNGATED' });

      // The maintenance pass (no chapter) still answers, so the old meaning is intact.
      const maintenance = await call({});
      expect(maintenance.status).toBe(200);
      expect(maintenance.body).toMatchObject({ ok: true });
      expect(listUngated(fixture.db)).toEqual([]);
    } finally {
      await app.close();
      fixture.close();
    }
  });
});
