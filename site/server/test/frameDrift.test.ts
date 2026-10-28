/**
 * BOOK-109 — `FRAME_DRIFT`: the served frame against the manuscript's.
 *
 * The owner read ch01/ch42 as text no file held, and neither the pages nor the probe could say
 * which side of the projection was wrong. The check compares the block a request is about to
 * serve with the paragraph the file holds, so the log line names both strings — and it speaks
 * only for the two chapters that carry the frame.
 *
 * The unit cases pin the comparison itself (agreement, either end, a re-wrapped paragraph, an
 * unreadable file); the integration ones are the real road: a row updated under the route's
 * feet, the answer still a 200, and one JSON line carrying both texts — once per *distinct*
 * drift, not once per reader page view (BOOK-109 review).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, TOTAL_CHAPTERS } from '@book/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { checkFrameDrift, frameFile } from '../src/http/frameDrift.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createFixture, longProse, type Fixture } from './helpers.ts';

const roots: string[] = [];
let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;

afterEach(() => {
  app = null;
  fixture?.close();
  fixture = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A directory this file owns and removes — a book root, or the app's built SPA. */
function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A book root holding only the files a case needs. */
function bookRoot(files: Record<string, string>): string {
  const root = tempDir('book-frame-');
  mkdirSync(join(root, 'manuscript'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, 'manuscript', name), text, 'utf8');
  return root;
}

/** The app with a log stream, and the lines it wrote — parsed once at the assertion. */
async function bootLogged(): Promise<{ lines: string[]; records: () => Array<Record<string, unknown>> }> {
  fixture = createFixture({ 'ch01.md': longProse(['Первый абзац главы.']) });
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
  const lines: string[] = [];
  app = await buildApp({
    config: loadConfig({
      BOOK_ROOT: fixture.root,
      DATA_DIR: fixture.dataDir,
      WEB_DIST: tempDir('book-web-'),
      PORT: '8080',
    }),
    db: fixture.db,
    state: new StateService(fixture.db),
    version: 'test',
    logStream: { write: (line) => lines.push(line) },
  });
  return {
    lines,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('checkFrameDrift — ch01 opens the frame, the finale closes it (BOOK-109)', () => {
  it('says nothing when the served first paragraph is the file’s first paragraph', () => {
    const root = bookRoot({ 'ch01.md': `${FRAME_FIRST_SENTENCE}\n` });
    expect(checkFrameDrift({ bookRoot: root }, 1, [{ text: FRAME_FIRST_SENTENCE }])).toBeNull();
  });

  it('returns both texts when ch01 serves a first paragraph the file does not hold', () => {
    const root = bookRoot({ 'ch01.md': `Заголовок главы\n\n${FRAME_FIRST_SENTENCE}\n\nВторой абзац.` });
    const served = 'Рано утром я проснулся по будильнику, был обычный будний день.';
    const check = checkFrameDrift({ bookRoot: root }, 1, [{ text: served }, { text: 'Второй абзац.' }]);
    expect(check).toEqual({
      file: join(root, 'manuscript', 'ch01.md'),
      served,
      manuscript: FRAME_FIRST_SENTENCE,
    });
  });

  it('compares the last paragraph of the finale, not its first', () => {
    const root = bookRoot({ 'ch42.md': `Последняя глава\n\nОткрывающий абзац.\n\n${FRAME_LAST_SENTENCE}` });
    const blocks = [{ text: 'Открывающий абзац.' }, { text: 'И никого не стало.' }];
    const check = checkFrameDrift({ bookRoot: root }, TOTAL_CHAPTERS, blocks);
    expect(check).toEqual({
      file: frameFile(root, TOTAL_CHAPTERS),
      served: 'И никого не стало.',
      manuscript: FRAME_LAST_SENTENCE,
    });
    // The opening paragraph agrees, so the same file aligned at the other end is silence.
    expect(
      checkFrameDrift({ bookRoot: root }, TOTAL_CHAPTERS, [{ text: 'Открывающий абзац.' }, { text: FRAME_LAST_SENTENCE }]),
    ).toBeNull();
  });

  it('does not read whitespace as drift: a re-wrapped paragraph is the same paragraph', () => {
    const root = bookRoot({ 'ch01.md': `Заголовок главы\n\nЯ вошёл в пустую\nкомнату.   Её освещал яркий свет.` });
    const check = checkFrameDrift({ bookRoot: root }, 1, [{ text: 'Я вошёл в пустую комнату.  Её освещал яркий свет.' }]);
    expect(check).toBeNull();
  });

  it('reports a readable but empty body as drift rather than as agreement', () => {
    const root = bookRoot({ 'ch42.md': '' });
    expect(checkFrameDrift({ bookRoot: root }, TOTAL_CHAPTERS, [{ text: FRAME_LAST_SENTENCE }])).toEqual({
      file: frameFile(root, TOTAL_CHAPTERS),
      served: FRAME_LAST_SENTENCE,
      manuscript: '',
    });
  });

  it('does not throw on a missing file, and asks nothing of the other chapters', () => {
    const root = bookRoot({});
    const missing = checkFrameDrift({ bookRoot: root }, 1, [{ text: FRAME_FIRST_SENTENCE }]);
    expect(missing).not.toBeNull();
    expect(missing !== null && 'unreadable' in missing).toBe(true);

    // Ch 12 has no frame: no file is read at all, so a broken seam would fail here.
    const exploding = { readFile: (): string => { throw new Error('must not be read'); } };
    expect(checkFrameDrift({ bookRoot: root, ...exploding }, 12, [{ text: 'Абзац.' }])).toBeNull();
  });
});

/** Values written above: the owner's report, and a second, different corruption. */
const WRONG = 'Рано утром я проснулся по будильнику, был обычный будний день.';
/** BOOK-137: the fixture's ch01 file opens on the canon frame, so its first paragraph is this. */
const MANUSCRIPT_FIRST = `${FRAME_FIRST_SENTENCE} Первый абзац главы.`;
const WRONG_AGAIN = 'Другая подмена первого абзаца.';

/** A row the file does not hold: the shape of the owner's report — old prose, new file. */
function setFirstBlock(text: string): void {
  fixture!.db.prepare(`UPDATE blocks SET text = ? WHERE chapter = 1 AND idx = 0`).run(text);
}

/** `onResponse` fires after the reply; one turn of the loop is enough for the last line. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function driftLines(log: { records: () => Array<Record<string, unknown>> }): Array<Record<string, unknown>> {
  return log.records().filter((record) => record.msg === 'FRAME_DRIFT');
}

describe('GET /api/chapters/:n logs FRAME_DRIFT and still serves (BOOK-109)', () => {
  it('writes one line with both texts when the projection and the manuscript disagree', async () => {
    const log = await bootLogged();
    setFirstBlock(WRONG);

    const response = await app!.inject({ method: 'GET', url: '/api/chapters/1' });
    expect(response.statusCode).toBe(200);
    expect(response.json().blocks[0].text).toBe(WRONG);
    await settle();

    const drift = driftLines(log);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ chapter: 1, served: WRONG, manuscript: MANUSCRIPT_FIRST });
    expect(String(drift[0]?.file)).toBe(join(fixture!.root, 'manuscript', 'ch01.md'));
  });

  it('says nothing when the projection agrees with the file', async () => {
    const log = await bootLogged();

    expect((await app!.inject({ method: 'GET', url: '/api/chapters/1' })).statusCode).toBe(200);
    await settle();
    expect(log.lines.filter((line) => line.includes('FRAME_DRIFT'))).toEqual([]);
  });

  it('logs once per distinct drift, and again after agreement and a recurrence', async () => {
    const log = await bootLogged();

    // A projection that stays wrong is one line, not one per reader page view.
    setFirstBlock(WRONG);
    await app!.inject({ method: 'GET', url: '/api/chapters/1' });
    await app!.inject({ method: 'GET', url: '/api/chapters/1' });
    await settle();
    expect(driftLines(log)).toHaveLength(1);

    // A different drift is news: the stored signature is the pair of texts, not a flag.
    setFirstBlock(WRONG_AGAIN);
    await app!.inject({ method: 'GET', url: '/api/chapters/1' });
    await settle();
    expect(driftLines(log)).toHaveLength(2);
    expect(driftLines(log)[1]).toMatchObject({ served: WRONG_AGAIN, manuscript: MANUSCRIPT_FIRST });

    // Agreement clears the memory, so the same drift returning later is reported again.
    setFirstBlock(MANUSCRIPT_FIRST);
    await app!.inject({ method: 'GET', url: '/api/chapters/1' });
    await settle();
    expect(driftLines(log)).toHaveLength(2);

    setFirstBlock(WRONG);
    await app!.inject({ method: 'GET', url: '/api/chapters/1' });
    await settle();
    expect(driftLines(log)).toHaveLength(3);
  });

  it('reports an unreadable frame file once per process, with the reason', async () => {
    const log = await bootLogged();
    rmSync(join(fixture!.root, 'manuscript', 'ch01.md'), { force: true });

    expect((await app!.inject({ method: 'GET', url: '/api/chapters/1' })).statusCode).toBe(200);
    expect((await app!.inject({ method: 'GET', url: '/api/chapters/1' })).statusCode).toBe(200);
    await settle();

    const unreadable = log.records().filter((record) => record.msg === 'FRAME_DRIFT unreadable');
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toMatchObject({ chapter: 1 });
    expect(String(unreadable[0]?.reason)).toMatch(/ENOENT|no such file/u);
    // The drift line itself never fires for a file that could not be read: an unanswerable
    // check is not a claim that the text is wrong.
    expect(log.records().filter((record) => record.msg === 'FRAME_DRIFT')).toEqual([]);
  });
});
