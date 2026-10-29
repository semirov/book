/**
 * BOOK-109 / BOOK-187 — `FRAME_DRIFT`: the served frame against the row the volume holds.
 *
 * The owner read ch01/ch42 as text no source held, and neither the pages nor the probe could say
 * which side of the projection was wrong. Since v28 the comparison reads no file: the block a
 * request is about to serve is compared with the sentence `book_frame` keeps, so the log line
 * names both strings — and it speaks only for the two chapters that carry the frame.
 *
 * The unit cases pin the comparison itself (agreement, either end, a re-wrapped paragraph, a
 * missing row); the integration ones are the real road: a row updated under the route's feet, the
 * answer still a 200, and one JSON line carrying both texts — once per *distinct* drift, not once
 * per reader page view (BOOK-109 review).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, TOTAL_CHAPTERS } from '@book/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { frameOf, frameSha, type FramePosition } from '../src/db/repo/frame.ts';
import { checkFrameDrift, framePositionOf, frameSource } from '../src/http/frameDrift.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { sha256Hex } from '../src/util/hash.ts';
import { AGE_ACK_COOKIE, createFixture, longProse, type Fixture } from './helpers.ts';

const roots: string[] = [];
let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;

afterEach(() => {
  app = null;
  fixture?.close();
  fixture = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A directory this file owns and removes — the app's built SPA in these cases. */
function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A reader over a fixed set of rows: the seam a database would fill in production. */
function rowsOf(rows: Partial<Record<string, string>>) {
  return (_chapter: number, position: FramePosition): string | null => rows[position] ?? null;
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

describe('checkFrameDrift — ch01 opens the frame, the finale closes it (BOOK-109, BOOK-187)', () => {
  it('says nothing when the served first block opens with the row', () => {
    const frameOf = rowsOf({ first: FRAME_FIRST_SENTENCE });
    expect(checkFrameDrift({ frameOf }, 1, [{ text: `${FRAME_FIRST_SENTENCE} Я постоял и вышел.` }])).toBeNull();
  });

  it('returns both texts when ch01 serves a first block that lost the sentence', () => {
    const frameOf = rowsOf({ first: FRAME_FIRST_SENTENCE });
    const served = 'Рано утром я проснулся по будильнику, был обычный будний день.';
    expect(checkFrameDrift({ frameOf }, 1, [{ text: served }, { text: 'Второй абзац.' }])).toEqual({
      source: frameSource(1, 'first'),
      served,
      stored: FRAME_FIRST_SENTENCE,
    });
  });

  it('compares the last block of the finale, not its first', () => {
    const frameOf = rowsOf({ last: FRAME_LAST_SENTENCE });
    const blocks = [{ text: 'Открывающий абзац.' }, { text: 'И никого не стало.' }];
    expect(checkFrameDrift({ frameOf }, TOTAL_CHAPTERS, blocks)).toEqual({
      source: frameSource(TOTAL_CHAPTERS, 'last'),
      served: 'И никого не стало.',
      stored: FRAME_LAST_SENTENCE,
    });
    // The closing block carries the sentence at its end, so the same reader is silence.
    expect(
      checkFrameDrift({ frameOf }, TOTAL_CHAPTERS, [{ text: 'Открывающий абзац.' }, { text: `И никого не стало. ${FRAME_LAST_SENTENCE}` }]),
    ).toBeNull();
  });

  it('does not read whitespace as drift: a re-wrapped block carries the same sentence', () => {
    const frameOf = rowsOf({ first: FRAME_FIRST_SENTENCE });
    const rewrapped = FRAME_FIRST_SENTENCE.replace('Её', '\nЕё').replace('  ', ' ');
    expect(checkFrameDrift({ frameOf }, 1, [{ text: `${rewrapped} И дальше идёт текст главы.` }])).toBeNull();
  });

  it('reports a missing row as unreadable, and asks nothing of the other chapters', () => {
    const missing = checkFrameDrift({ frameOf: rowsOf({}) }, 1, [{ text: FRAME_FIRST_SENTENCE }]);
    expect(missing).not.toBeNull();
    expect(missing !== null && 'unreadable' in missing).toBe(true);
    expect(missing !== null && 'source' in missing && missing.source).toBe('book_frame/1/first');

    // Ch 12 has no frame: no row is read at all, so an exploding reader would fail here.
    const exploding = {
      frameOf: (): string => {
        throw new Error('must not be read');
      },
    };
    expect(checkFrameDrift(exploding, 12, [{ text: 'Абзац.' }])).toBeNull();
    expect([1, TOTAL_CHAPTERS, 12].map(framePositionOf)).toEqual(['first', 'last', null]);
  });
});

/** Values written above: the owner's report, and a second, different corruption. */
const WRONG = 'Рано утром я проснулся по будильнику, был обычный будний день.';
/** BOOK-137: the fixture's ch01 file opens on the canon frame, so its first block is this. */
const FRAME_BLOCK = `${FRAME_FIRST_SENTENCE} Первый абзац главы.`;
const WRONG_AGAIN = 'Другая подмена первого абзаца.';

/** A row the block does not carry: the shape of the owner's report — old prose, new row. */
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
  it('writes one line with both texts when the served block and the row disagree', async () => {
    const log = await bootLogged();
    setFirstBlock(WRONG);

    const response = await app!.inject({ method: 'GET', headers: { cookie: AGE_ACK_COOKIE }, url: '/api/chapters/1' });
    expect(response.statusCode).toBe(200);
    expect(response.json().blocks[0].text).toBe(WRONG);
    await settle();

    const drift = driftLines(log);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ chapter: 1, served: WRONG, stored: FRAME_FIRST_SENTENCE });
    expect(String(drift[0]?.source)).toBe('book_frame/1/first');
  });

  it('says nothing when the served block carries the row', async () => {
    const log = await bootLogged();
    // The fixture's own ch01 block: the canon sentence, then the paragraph beside it.
    expect(fixture!.db.prepare('SELECT text FROM blocks WHERE chapter = 1 AND idx = 0').get()).toEqual({ text: FRAME_BLOCK });

    expect((await app!.inject({ method: 'GET', headers: { cookie: AGE_ACK_COOKIE }, url: '/api/chapters/1' })).statusCode).toBe(200);
    await settle();
    expect(log.lines.filter((line) => line.includes('FRAME_DRIFT'))).toEqual([]);
  });

  it('logs once per distinct drift, and again after agreement and a recurrence', async () => {
    const log = await bootLogged();

    // A projection that stays wrong is one line, not one per reader page view.
    setFirstBlock(WRONG);
    await app!.inject({ method: 'GET', headers: { cookie: AGE_ACK_COOKIE }, url: '/api/chapters/1' });
    await app!.inject({ method: 'GET', headers: { cookie: AGE_ACK_COOKIE }, url: '/api/chapters/1' });
    await settle();
    expect(driftLines(log)).toHaveLength(1);

    // A different drift is news: the stored signature is the pair of texts, not a flag.
    setFirstBlock(WRONG_AGAIN);
    await app!.inject({ method: 'GET', headers: { cookie: AGE_ACK_COOKIE }, url: '/api/chapters/1' });
    await settle();
    expect(driftLines(log)).toHaveLength(2);
    expect(driftLines(log)[1]).toMatchObject({ served: WRONG_AGAIN, stored: FRAME_FIRST_SENTENCE });

    // Agreement clears the memory, so the same drift returning later is reported again.
    setFirstBlock(FRAME_BLOCK);
    await app!.inject({ method: 'GET', headers: { cookie: AGE_ACK_COOKIE }, url: '/api/chapters/1' });
    await settle();
    expect(driftLines(log)).toHaveLength(2);

    setFirstBlock(WRONG);
    await app!.inject({ method: 'GET', headers: { cookie: AGE_ACK_COOKIE }, url: '/api/chapters/1' });
    await settle();
    expect(driftLines(log)).toHaveLength(3);
  });

  it('reports a missing frame row once per process, with the reason', async () => {
    const log = await bootLogged();
    // A volume whose seed never ran (a pre-v28 database) has no row to compare against.
    fixture!.db.prepare('DELETE FROM book_frame WHERE chapter = 1').run();

    expect((await app!.inject({ method: 'GET', headers: { cookie: AGE_ACK_COOKIE }, url: '/api/chapters/1' })).statusCode).toBe(200);
    expect((await app!.inject({ method: 'GET', headers: { cookie: AGE_ACK_COOKIE }, url: '/api/chapters/1' })).statusCode).toBe(200);
    await settle();

    const unreadable = log.records().filter((record) => record.msg === 'FRAME_DRIFT unreadable');
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toMatchObject({ chapter: 1, source: 'book_frame/1/first' });
    expect(String(unreadable[0]?.reason)).toMatch(/no book_frame row/u);
    // The drift line itself never fires for a row that is not there: an unanswerable check is
    // not a claim that the text is wrong.
    expect(log.records().filter((record) => record.msg === 'FRAME_DRIFT')).toEqual([]);
  });
});

describe('frameOf — the reader the route hands over (BOOK-187)', () => {
  it('answers the seeded sentence and null for a chapter without a frame', () => {
    fixture = createFixture({});
    expect(frameOf(fixture.db, 1, 'first')).toBe(FRAME_FIRST_SENTENCE);
    expect(frameOf(fixture.db, TOTAL_CHAPTERS, 'last')).toBe(FRAME_LAST_SENTENCE);
    expect(frameOf(fixture.db, 12, 'first')).toBeNull();
    // The health answer reads the hashes the same way: a row that is not there has none.
    expect(frameSha(fixture.db, 1, 'first')).toBe(sha256Hex(FRAME_FIRST_SENTENCE));
    expect(frameSha(fixture.db, 12, 'first')).toBeNull();
  });
});
