import { appendFileSync, copyFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

import { FRAME_FIRST_SENTENCE } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { revisionOf } from '../../src/fb2/edition.ts';
import { renderFb2, type Fb2Input } from '../../src/fb2/serialize.ts';
import { reconcile } from '../../src/ingest/reconcile.ts';
import { longProse } from '../helpers.ts';
import {
  COVER_SOURCE,
  DISPOSITION,
  binaryOf,
  bootExport,
  cleanup,
  tempDir,
  withoutDate,
  versionOf,
  type ExportHarness,
} from './harness.ts';

/**
 * BOOK-60 — `GET /book.fb2` at the wire (BOOK-DOC-41 §2, §5); BOOK-133 adds the cover to the
 * tag and to the build key.
 *
 * The identity facts the owner asked for are asserted here: the version is the edition number,
 * the date is the export moment with the zone's offset, two exports of one state share the
 * version and differ in the date, and a text write moves the number. The build budget is
 * asserted with the serializer seam: a `304` builds nothing, spends one export slot, and sixty
 * reads of one edition build once — inside the route's transaction. A cover that changes is a
 * new representation: a new ETag, a new size, and exactly one rebuild, never a stale `304`.
 *
 * The file a browser saves, the size the page prints and the export's own budget are BOOK-138's
 * and live in `download.test.ts` — one endpoint, two files, because a file is a unit of the
 * build (500 lines), not of the reading.
 */

let harness: ExportHarness | null = null;

async function boot(options: Parameters<typeof bootExport>[0] = {}): Promise<ExportHarness> {
  harness = await bootExport(options);
  return harness;
}

afterEach(async () => {
  await cleanup(harness);
  harness = null;
});

describe('the edition number (BOOK-DOC-41 §1)', () => {
  it('is the low 52 bits of the hash — the last 13 hex characters, not the first', () => {
    const hash = `${'f'.repeat(51)}123456789abcd`;
    expect(hash).toHaveLength(64);
    expect(revisionOf(hash)).toBe(Number(BigInt('0x123456789abcd')));
    expect(revisionOf(hash)).toBeLessThanOrEqual(4_503_599_627_370_495);
    // §5's "first 13 hex" is a wording slip: the low bits are what the schema holds.
    expect(revisionOf(hash)).not.toBe(Number(BigInt(`0x${'f'.repeat(13)}`)));
  });
});

describe('GET /book.fb2 (BOOK-60)', () => {
  it('AC2 — version is the edition number, date is the export moment with an offset; two exports of one state share the version and differ in date', async () => {
    let clock = new Date('2026-10-27T11:03:12Z');
    const held = await boot({
      chapters: { '00-front.md': 'Бланк\n', 'ch01.md': FRAME_FIRST_SENTENCE },
      now: () => clock,
    });
    const { app } = held;

    const first = await app.inject({ method: 'GET', url: '/book.fb2' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('application/x-fictionbook+xml; charset=utf-8');
    // BOOK-138: the edition changes with every chapter, so nothing is kept — the tag stays for
    // an explicit revalidation, which is the only revalidation a client can ask for.
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers['content-length']).toBe(String(Buffer.byteLength(first.body, 'utf8')));
    expect(first.headers['x-export-date']).toBe('2026-10-27T14:03:12+03:00');
    expect(first.body).toContain('<date value="2026-10-27">2026-10-27T14:03:12+03:00</date>');

    const version = versionOf(first.body);
    // The revision is a decimal ≤ 2^52 − 1: a valid xs:float lexical value (binary32 carries
    // it only approximately; the name's uniqueness lives in the full hash on the ETag).
    expect(Number(version)).toBeLessThanOrEqual(4_503_599_627_370_495);
    expect(first.headers['content-disposition']).toBe(DISPOSITION);
    // The tag is both untruncated hashes: the edition and the image.
    expect(first.headers.etag).toMatch(/^"fb2-[0-9a-f]{64}-[0-9a-f]{64}"$/u);

    // Same state, an hour later: the number stands, the moment moves.
    clock = new Date('2026-10-27T12:03:12Z');
    const second = await app.inject({ method: 'GET', url: '/book.fb2' });
    expect(second.statusCode).toBe(200);
    expect(versionOf(second.body)).toBe(version);
    expect(second.headers['x-export-date']).toBe('2026-10-27T15:03:12+03:00');
    expect(second.body).toContain('<date value="2026-10-27">2026-10-27T15:03:12+03:00</date>');
    expect(second.headers.etag).toBe(first.headers.etag);
    expect(withoutDate(second.body)).toBe(withoutDate(first.body));
  });

  it('AC3 — after a chapter write the number moves and the file carries the new paragraph', async () => {
    const held = await boot({ chapters: { 'ch01.md': FRAME_FIRST_SENTENCE } });
    const { app } = held;
    const first = await app.inject({ method: 'GET', url: '/book.fb2' });
    const before = versionOf(first.body);
    expect(first.body).not.toContain('Новый абзац после правки.');

    held.fixture.write('ch08.md', longProse(['Новый абзац после правки.']));
    reconcile(held.fixture.db, { bookRoot: held.fixture.root, dataDir: held.fixture.dataDir });

    const second = await app.inject({ method: 'GET', url: '/book.fb2' });
    const after = versionOf(second.body);
    expect(after).not.toBe(before);
    expect(second.body).toContain('Новый абзац после правки.');
    // The page and the file name the same edition (BOOK-DOC-41 §6).
    const front = (await app.inject({ method: 'GET', url: '/api/front' })).json();
    expect(front.revision).toBe(Number(after));
  });

  it('AC4 — a conditional request builds nothing: 304, serializer not called, one slot spent', async () => {
    const builds: boolean[] = [];
    const render = (input: Fb2Input): { head: string; tail: string } => {
      builds.push(harness!.fixture.db.inTransaction);
      return renderFb2(input);
    };
    const { app } = await boot({
      chapters: { 'ch01.md': FRAME_FIRST_SENTENCE },
      fb2: { render },
      env: { READ_PER_MINUTE: '2' },
    });

    const first = await app.inject({ method: 'GET', url: '/book.fb2' });
    expect(first.statusCode).toBe(200);
    // The build runs inside the route's transaction: the number and the paragraphs share one snapshot.
    expect(builds).toEqual([true]);

    const conditional = await app.inject({
      method: 'GET',
      url: '/book.fb2',
      headers: { 'if-none-match': first.headers.etag as string },
    });
    expect(conditional.statusCode).toBe(304);
    expect(builds).toHaveLength(1);
    expect(conditional.headers.etag).toBe(first.headers.etag);
    expect(conditional.headers['cache-control']).toBe('no-store');
    // No body was produced, so no export moment and no file name are claimed.
    expect(conditional.headers['x-export-date']).toBeUndefined();
    expect(conditional.headers['content-disposition']).toBeUndefined();
    expect(conditional.body).toBe('');

    // The 304 spent the second slot: the same network's next read is refused.
    const blocked = await app.inject({ method: 'GET', url: '/book.fb2' });
    expect(blocked.statusCode).toBe(429);
  });

  it('AC4 — sixty reads of one edition build once', async () => {
    let builds = 0;
    const render = (input: Fb2Input): { head: string; tail: string } => {
      builds += 1;
      return renderFb2(input);
    };
    const { app } = await boot({
      chapters: { 'ch01.md': FRAME_FIRST_SENTENCE },
      fb2: { render },
      env: { READ_PER_MINUTE: '60' },
    });

    for (let read = 0; read < 60; read += 1) {
      const response = await app.inject({ method: 'GET', url: '/book.fb2' });
      expect(response.statusCode, `read ${read + 1}`).toBe(200);
      expect(response.headers['x-export-date']).toBeTruthy();
    }
    expect(builds).toBe(1);
  });

  it('honours a weak validator as the same representation', async () => {
    const { app } = await boot({ chapters: { 'ch01.md': FRAME_FIRST_SENTENCE } });
    const first = await app.inject({ method: 'GET', url: '/book.fb2' });
    const conditional = await app.inject({
      method: 'GET',
      url: '/book.fb2',
      headers: { 'if-none-match': `W/${first.headers.etag as string}` },
    });
    expect(conditional.statusCode).toBe(304);
  });

  it('answers HEAD with the file’s headers and never builds', async () => {
    let builds = 0;
    const render = (input: Fb2Input): { head: string; tail: string } => {
      builds += 1;
      return renderFb2(input);
    };
    const { app } = await boot({ chapters: { 'ch01.md': FRAME_FIRST_SENTENCE }, fb2: { render } });

    const head = await app.inject({ method: 'HEAD', url: '/book.fb2' });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-type']).toBe('application/x-fictionbook+xml; charset=utf-8');
    expect(head.headers['content-disposition']).toBe(DISPOSITION);
    // BOOK-133: the tag names the edition *and* the image, so a HEAD has to `stat` the cover.
    expect(head.headers.etag).toMatch(/^"fb2-[0-9a-f]{64}-[0-9a-f]{64}"$/u);
    expect(head.headers['cache-control']).toBe('no-store');
    expect(head.headers['x-export-date']).toBeUndefined();
    expect(head.body).toBe('');
    expect(builds).toBe(0);

    // A HEAD revalidates like the GET: the tag is the edition, so nothing has to be built.
    const conditional = await app.inject({
      method: 'HEAD',
      url: '/book.fb2',
      headers: { 'if-none-match': head.headers.etag as string },
    });
    expect(conditional.statusCode).toBe(304);
    expect(conditional.headers.etag).toBe(head.headers.etag);
    expect(conditional.headers['cache-control']).toBe('no-store');
    expect(builds).toBe(0);
  });

  it('cover — a cover change moves the cache key and the ETag, and rebuilds once', async () => {
    // The real cover, copied: the repo copy stays read-only, the temp copy is the operand.
    const copy = join(tempDir(), 'cover.png');
    copyFileSync(COVER_SOURCE, copy);
    let builds = 0;
    const render = (input: Fb2Input): { head: string; tail: string } => {
      builds += 1;
      return renderFb2(input);
    };
    const { app } = await boot({
      chapters: { 'ch01.md': FRAME_FIRST_SENTENCE },
      fb2: { render },
      env: { COVER_PATH: copy },
    });

    const first = await app.inject({ method: 'GET', url: '/book.fb2' });
    expect(first.statusCode).toBe(200);
    expect(builds).toBe(1);
    const firstBinary = binaryOf(first.body);
    expect(firstBinary.length).toBeGreaterThan(1_000_000);

    // One appended byte plus a newer mtime: the same PNG header, a different file.
    appendFileSync(copy, Buffer.from([0x00]));
    const later = new Date(Date.now() + 1_000);
    utimesSync(copy, later, later);

    const second = await app.inject({ method: 'GET', url: '/book.fb2' });
    expect(second.statusCode).toBe(200);
    expect(builds).toBe(2);
    expect(second.headers.etag).not.toBe(first.headers.etag);
    expect(second.headers.etag).toMatch(/^"fb2-[0-9a-f]{64}-[0-9a-f]{64}"$/u);
    expect(binaryOf(second.body)).not.toBe(firstBinary);
    expect(Buffer.from(binaryOf(second.body), 'base64').length).toBe(1_108_248);

    // The new key is now the memo's: a third read rebuilds nothing.
    const third = await app.inject({ method: 'GET', url: '/book.fb2' });
    expect(third.statusCode).toBe(200);
    expect(builds).toBe(2);
    expect(third.headers.etag).toBe(second.headers.etag);
  });

  it('cover — a missing cover fails the export: 503 with the reason, no attachment, no XML', async () => {
    const missing = join(tempDir(), 'absent.png');
    const { app } = await boot({
      chapters: { 'ch01.md': FRAME_FIRST_SENTENCE },
      env: { COVER_PATH: missing },
    });

    const get = await app.inject({ method: 'GET', url: '/book.fb2' });
    expect(get.statusCode).toBe(503);
    expect(get.headers['cache-control']).toBe('no-store');
    expect(get.headers['content-disposition']).toBeUndefined();
    expect(get.body).not.toContain('<FictionBook');
    expect(get.json()).toEqual({ code: 'COVER_MISSING', message: `cover file is missing at ${missing}` });

    const head = await app.inject({ method: 'HEAD', url: '/book.fb2' });
    expect(head.statusCode).toBe(503);
    expect(head.headers['cache-control']).toBe('no-store');
    expect(head.headers['content-disposition']).toBeUndefined();
    // No XML, no attachment: the failure is a JSON reason, not a downloadable half-file.
    expect(head.body).not.toContain('<FictionBook');
  });
});
