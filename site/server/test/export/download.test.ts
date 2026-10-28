import { appendFileSync, copyFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

import { FRAME_FIRST_SENTENCE, TOTAL_CHAPTERS } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { renderFb2, type Fb2Input } from '../../src/fb2/serialize.ts';
import { reconcile } from '../../src/ingest/reconcile.ts';
import { longProse } from '../helpers.ts';
import {
  COVER_SOURCE,
  DISPOSITION,
  bootExport,
  cleanup,
  tempDir,
  versionOf,
  type ExportHarness,
} from './harness.ts';

/**
 * BOOK-138 — the download as the reader meets it: the name a browser saves, the answer's cache
 * policy, the size the page prints beside the link, and the export's own budget.
 *
 * The invariants are pairs, and each is asserted as one: the size `/api/front` prints is the
 * `content-length` of the file `/book.fb2` sends, for one edition and one `now` — the cover
 * included; a cover swap moves the tag and the size together, because the memo's key names the
 * image; and a cover that cannot be embedded fails the export while page 1 still answers.
 *
 * The endpoint's identity (version, date, `304`, HEAD) is `route.test.ts`; this file is the
 * other half of the same reading, split because a file is a unit of the build (500 lines).
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

describe('the file a browser saves (BOOK-138)', () => {
  it('AC — names it «Бланк.fb2» for every client, in both forms, on GET and on HEAD', async () => {
    const { app } = await boot({ chapters: { 'ch01.md': FRAME_FIRST_SENTENCE } });
    const get = await app.inject({ method: 'GET', url: '/book.fb2' });
    expect(get.headers['content-disposition']).toBe(DISPOSITION);
    // The UTF-8 form is the name, spelled by `encodeURIComponent`, not pasted as escapes.
    expect(get.headers['content-disposition']).toContain(
      `filename*=UTF-8''${encodeURIComponent('Бланк')}.fb2`,
    );
    // The edition number is not in the name: it is in the file and on the ETag.
    expect(get.headers['content-disposition']).not.toContain(String(versionOf(get.body)));
    const head = await app.inject({ method: 'HEAD', url: '/book.fb2' });
    expect(head.headers['content-disposition']).toBe(DISPOSITION);
  });

  it('AC — nothing is stored: 200, HEAD and the 304 branch all answer no-store', async () => {
    const { app } = await boot({ chapters: { 'ch01.md': FRAME_FIRST_SENTENCE } });
    const get = await app.inject({ method: 'GET', url: '/book.fb2' });
    expect(get.headers['cache-control']).toBe('no-store');
    const notModified = await app.inject({
      method: 'GET',
      url: '/book.fb2',
      headers: { 'if-none-match': get.headers.etag as string },
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.headers['cache-control']).toBe('no-store');
    // The tag survives the policy: an explicit revalidation is still truthful.
    expect(notModified.headers.etag).toBe(get.headers.etag);
    const head = await app.inject({ method: 'HEAD', url: '/book.fb2' });
    expect(head.headers['cache-control']).toBe('no-store');
    const headNotModified = await app.inject({
      method: 'HEAD',
      url: '/book.fb2',
      headers: { 'if-none-match': head.headers.etag as string },
    });
    expect(headNotModified.statusCode).toBe(304);
    expect(headNotModified.headers['cache-control']).toBe('no-store');
  });
});

describe('the size the page prints (BOOK-138)', () => {
  const clock = new Date('2026-10-27T11:03:12Z');

  it('AC — /api/front’s exportBytes is the content-length of the file, for one edition and one now', async () => {
    const { app } = await boot({
      chapters: {
        '00-front.md': FRAME_FIRST_SENTENCE,
        'ch02.md': longProse(['Размер — это байты.']),
        'ch08.md': longProse(['Ещё один абзац.']),
      },
      now: () => clock,
    });
    const front = (await app.inject({ method: 'GET', url: '/api/front' })).json();
    const file = await app.inject({ method: 'GET', url: '/book.fb2' });

    expect(file.statusCode).toBe(200);
    expect(typeof front.exportBytes).toBe('number');
    expect(front.exportBytes).toBe(Number(file.headers['content-length']));
    expect(front.exportBytes).toBe(Buffer.byteLength(file.body, 'utf8'));
    // The size describes the same edition the page names.
    expect(front.revision).toBe(Number(versionOf(file.body)));
    // BOOK-133: a real size, and the cover is most of it.
    expect(front.exportBytes).toBeGreaterThan(1_000_000);
  });

  it('AC — one edition is built once, whichever surface asks first', async () => {
    let builds = 0;
    const render = (input: Fb2Input): { head: string; tail: string } => {
      builds += 1;
      return renderFb2(input);
    };
    const { app } = await boot({ chapters: { 'ch01.md': FRAME_FIRST_SENTENCE }, fb2: { render }, now: () => clock });

    // The page asks first: it pays the one build, and the download reuses it.
    expect((await app.inject({ method: 'GET', url: '/api/front' })).statusCode).toBe(200);
    expect(builds).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/book.fb2' })).statusCode).toBe(200);
    expect(builds).toBe(1);
  });

  it('AC — a new edition rebuilds and moves both numbers together', async () => {
    const held = await boot({ chapters: { 'ch01.md': FRAME_FIRST_SENTENCE }, now: () => clock });
    const { app } = held;
    const before = (await app.inject({ method: 'GET', url: '/api/front' })).json();

    held.fixture.write('ch08.md', longProse(['После правки файл длиннее.', 'И ещё абзац.']));
    reconcile(held.fixture.db, { bookRoot: held.fixture.root, dataDir: held.fixture.dataDir });

    const after = (await app.inject({ method: 'GET', url: '/api/front' })).json();
    const file = await app.inject({ method: 'GET', url: '/book.fb2' });
    expect(after.exportBytes).toBe(Number(file.headers['content-length']));
    expect(after.revision).not.toBe(before.revision);
    expect(after.exportBytes).toBeGreaterThan(before.exportBytes);
  });
});

describe('the cover in the size (BOOK-133 / BOOK-138)', () => {
  const clock = new Date('2026-10-27T11:03:12Z');

  it('AC — a cover swap moves the ETag and exportBytes together: the memo key names the image', async () => {
    // The real cover, copied: the repo file stays read-only, the temp copy is the operand.
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
      now: () => clock,
    });

    const firstFront = (await app.inject({ method: 'GET', url: '/api/front' })).json();
    const firstFile = await app.inject({ method: 'GET', url: '/book.fb2' });
    expect(firstFile.statusCode).toBe(200);
    expect(firstFront.exportBytes).toBe(Number(firstFile.headers['content-length']));
    expect(builds).toBe(1);

    // A different image: three appended bytes and a newer mtime — the same PNG header, another
    // file. Three, not one: base64 grows by four characters per whole triple, so a one-byte
    // swap would move the hash and leave the length alone — this test has to move both.
    appendFileSync(copy, Buffer.from([0x00, 0x00, 0x00]));
    const later = new Date(Date.now() + 1_000);
    utimesSync(copy, later, later);

    const secondFront = (await app.inject({ method: 'GET', url: '/api/front' })).json();
    const secondFile = await app.inject({ method: 'GET', url: '/book.fb2' });

    // The regression: keyed by the edition hash alone, the memo would answer with the previous
    // `<binary>` and the page would print the previous file's length under the new tag.
    expect(secondFile.statusCode).toBe(200);
    expect(builds).toBe(2);
    expect(secondFile.headers.etag).not.toBe(firstFile.headers.etag);
    // The manuscript did not move: the tag and the size moved for the image's sake.
    expect(secondFront.revision).toBe(firstFront.revision);
    expect(secondFront.exportBytes).not.toBe(firstFront.exportBytes);
    expect(secondFront.exportBytes).toBe(firstFront.exportBytes + 4);
    expect(secondFront.exportBytes).toBe(Number(secondFile.headers['content-length']));
    expect(secondFront.exportBytes).toBe(Buffer.byteLength(secondFile.body, 'utf8'));
  });

  it('AC — a broken cover does not fail page 1: 200, no exportBytes, the page intact', async () => {
    const missing = join(tempDir(), 'absent.png');
    const { app } = await boot({
      chapters: { 'ch01.md': FRAME_FIRST_SENTENCE },
      env: { COVER_PATH: missing },
      now: () => clock,
    });

    const response = await app.inject({ method: 'GET', url: '/api/front' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // A page is a statement about the manuscript; an image that cannot be embedded is not a
    // reason to take page 1 away. The link prints the verb alone.
    expect(body).not.toHaveProperty('exportBytes');
    expect(body).toMatchObject({ title: null, about: null });
    expect(body.rev).toEqual(expect.any(Number));
    expect(body.toc).toHaveLength(TOTAL_CHAPTERS);
    expect(body.authors).toMatchObject({ count: 0 });
    expect(typeof body.revision).toBe('number');

    // The export itself still fails loudly — BOOK-133's rule, not softened by the shared memo.
    const file = await app.inject({ method: 'GET', url: '/book.fb2' });
    expect(file.statusCode).toBe(503);
    expect(file.json()).toMatchObject({ code: 'COVER_MISSING' });
  });
});

describe('the export’s own budget (BOOK-138)', () => {
  it('AC — a reader’s second click in a row is another file, not a refusal', async () => {
    const { app } = await boot({ chapters: { 'ch01.md': FRAME_FIRST_SENTENCE } });
    for (let click = 1; click <= 2; click += 1) {
      const response = await app.inject({ method: 'GET', url: '/book.fb2' });
      expect(response.statusCode, `click ${click}`).toBe(200);
      expect(response.body).toContain('<FictionBook');
    }
  });

  it('AC — spending the page’s read budget does not take the download away', async () => {
    const { app } = await boot({ chapters: { 'ch01.md': FRAME_FIRST_SENTENCE }, env: { READ_PER_MINUTE: '2' } });
    for (let poll = 1; poll <= 2; poll += 1) {
      expect((await app.inject({ method: 'GET', url: '/api/state' })).statusCode, `poll ${poll}`).toBe(200);
    }
    // The page's own polls are refused now — and the export is not.
    expect((await app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(429);
    const download = await app.inject({ method: 'GET', url: '/book.fb2' });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toBe(DISPOSITION);
    expect((await app.inject({ method: 'HEAD', url: '/book.fb2' })).statusCode).toBe(200);
  });

  it('AC — the export’s budget is spent by its own requests, GET and HEAD alike', async () => {
    const { app } = await boot({ chapters: { 'ch01.md': FRAME_FIRST_SENTENCE }, env: { READ_PER_MINUTE: '1' } });
    expect((await app.inject({ method: 'GET', url: '/book.fb2' })).statusCode).toBe(200);

    const blocked = await app.inject({ method: 'GET', url: '/book.fb2' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // A query string is not a way around it, and HEAD takes a slot like GET.
    expect((await app.inject({ method: 'GET', url: '/book.fb2?download=1' })).statusCode).toBe(429);
    expect((await app.inject({ method: 'HEAD', url: '/book.fb2' })).statusCode).toBe(429);
    // The read budget is untouched: a state poll still answers.
    expect((await app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(200);
  });
});

describe('the empty book (BOOK-138 §5)', () => {
  it('AC — answers 200 with the description, no prose in any slot, and its real size', async () => {
    const clock = new Date('2026-10-27T11:03:12Z');
    const held = await boot({ now: () => clock });
    const { app } = held;
    const front = (await app.inject({ method: 'GET', url: '/api/front' })).json();
    const file = await app.inject({ method: 'GET', url: '/book.fb2' });

    expect(file.statusCode).toBe(200);
    expect(file.body).toContain('<book-title>Книга</book-title>');
    expect(file.body).toContain('<author><nickname>');

    // No chapter was written, so no slot carries prose: every one is the titled empty section
    // of BOOK-DOC-41 §3 — and no invented placeholder paragraph anywhere.
    const sections = [...file.body.matchAll(/<section [\s\S]*?<\/section>/gu)].map((match) => match[0]);
    expect(sections).toHaveLength(TOTAL_CHAPTERS);
    for (const section of sections) {
      expect(section).toMatch(/^<section id="ch\d+"><title><p>Глава \d+<\/p><\/title><empty-line\/><\/section>$/u);
    }

    // BOOK-133: the file is not a kilobyte of XML any more — it carries the whole cover, so the
    // size is the image's base64 plus the description. What is honest to assert about "empty"
    // is the prose, not a small number: the length is the file's own, and a written chapter
    // adds to it.
    expect(file.body).toContain('<binary id="cover.png"');
    expect(front.exportBytes).toBe(Number(file.headers['content-length']));
    expect(front.exportBytes).toBe(Buffer.byteLength(file.body, 'utf8'));
    // The cover alone is 1 108 247 bytes (`cover.test.ts`); its base64 is larger still.
    expect(front.exportBytes).toBeGreaterThan(1_000_000);
    const empty = front.exportBytes as number;

    // Two written chapters are prose on top of the same cover: the file grows and the page's
    // number grows with it.
    held.fixture.write('ch02.md', longProse(['Первая написанная глава.']));
    held.fixture.write('ch08.md', longProse(['Вторая написанная глава.']));
    reconcile(held.fixture.db, { bookRoot: held.fixture.root, dataDir: held.fixture.dataDir });
    const writtenFront = (await app.inject({ method: 'GET', url: '/api/front' })).json();
    const writtenFile = await app.inject({ method: 'GET', url: '/book.fb2' });
    expect(writtenFront.exportBytes).toBe(Number(writtenFile.headers['content-length']));
    expect(writtenFront.exportBytes).toBeGreaterThan(empty);
  });
});
