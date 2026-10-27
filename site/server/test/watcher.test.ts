import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, type CatalogEntry } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { listCatalog } from '../src/db/repo/chapters.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import {
  ManuscriptWatcher,
  type IngestEvent,
  chapterNumberOf,
  isIgnoredPath,
} from '../src/ingest/watcher.ts';
import { sha256Hex } from '../src/util/hash.ts';
import { createFixture, type Fixture } from './helpers.ts';

const ABOUT =
  'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.';
const FRONT = `Без названия\n\n${ABOUT}\n`;
const NEW_ABOUT = `${ABOUT} Дополнительное служебное предложение.`;
const FRONT_TWO = `Тестовая глава\n\n${NEW_ABOUT}\n`;

type Harness = {
  fixture: Fixture;
  state: StateService;
  watcher: ManuscriptWatcher;
  events: IngestEvent[];
  stop: () => Promise<void>;
};

let harness: Harness | null = null;

async function start(options: { emptyGraceMs?: number; authorsCount?: () => { count: number; measuredAt: string } } = {}): Promise<Harness> {
  const fixture = createFixture({ '00-front.md': FRONT });
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
  const state = new StateService(fixture.db);
  const events: IngestEvent[] = [];
  const watcher = new ManuscriptWatcher({
    db: fixture.db,
    state,
    bookRoot: fixture.root,
    dataDir: fixture.dataDir,
    pollMs: 20,
    stabilityMs: 20,
    coalesceMs: 40,
    emptyGraceMs: options.emptyGraceMs ?? 120,
    emit: (event) => events.push(event),
    ...(options.authorsCount === undefined ? {} : { authorsCount: options.authorsCount }),
    log: () => undefined,
  });
  await watcher.start();
  // Polling sees mtime/size: let the initial stat settle before rewriting a same-size
  // file in the same millisecond (production writes are minutes apart and much larger).
  await new Promise((resolve) => setTimeout(resolve, 25));
  harness = {
    fixture,
    state,
    watcher,
    events,
    stop: async () => {
      await watcher.stop();
      fixture.close();
    },
  };
  return harness;
}

async function waitFor<T>(check: () => T | null | undefined | false, timeoutMs = 8_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the watcher');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function catalog(): CatalogEntry[] {
  return listCatalog(harness!.fixture.db);
}

afterEach(async () => {
  await harness?.stop();
  harness = null;
});

describe('watcher path classifier', () => {
  const root = '/book/manuscript';

  it('sees chapters 1..67 and the first sheet', () => {
    expect(chapterNumberOf('ch01.md')).toBe(1);
    expect(chapterNumberOf('ch67.md')).toBe(67);
    expect(chapterNumberOf('ch68.md')).toBeNull();
    expect(chapterNumberOf('ch1.md')).toBeNull();
    expect(chapterNumberOf('00-front.md')).toBeNull();
  });

  it('ignores archives, temporaries and planning files (§6.1)', () => {
    expect(isIgnoredPath(join(root, 'archive', 'ch01.md'), root)).toBe(true);
    expect(isIgnoredPath(join(root, 'PLAN.md'), root)).toBe(true);
    expect(isIgnoredPath(join(root, '.gitkeep'), root)).toBe(true);
    expect(isIgnoredPath(join(root, 'ch01.md.tmp'), root)).toBe(true);
    expect(isIgnoredPath(join(root, 'ch01.md~'), root)).toBe(true);
    expect(isIgnoredPath(join(root, 'ch01.md'), root)).toBe(false);
    expect(isIgnoredPath(join(root, '00-front.md'), root)).toBe(false);
    expect(isIgnoredPath(root, root)).toBe(false);
  });
});

describe('watcher: a chapter appears', () => {
  it('creates revision 1, parses the title line and broadcasts created + state', async () => {
    await start();
    harness!.fixture.write(
      'ch01.md',
      'Тестовая глава\n\nПервый абзац главы.\n\nВторой абзац главы, подлиннее первого.\n',
    );

    const created = await waitFor(() => harness!.events.find((event) => event.type === 'chapter:created'));
    expect(created).toMatchObject({
      type: 'chapter:created',
      data: { n: 1, rev: 1, title: 'Тестовая глава', part: 1, direction: 'forward', attributed: false },
    });
    if (created.type !== 'chapter:created') throw new Error('narrowing');
    expect(created.data.chars).toBeGreaterThan(0);
    expect(created.data.fetch).toEqual({ path: '/api/chapters/1', etag: 'ch01-r1-b0' });

    const stateEvent = await waitFor(() => harness!.events.find((event) => event.type === 'state:updated'));
    expect(stateEvent.type).toBe('state:updated');
    if (stateEvent.type !== 'state:updated') throw new Error('narrowing');
    expect(stateEvent.data.reason).toBe('file');
    expect(stateEvent.data.chapters.written).toEqual([1]);

    expect(catalog()[0]).toMatchObject({ n: 1, title: 'Тестовая глава', rev: 1, written: true });
  }, 10_000);
});

describe('watcher: a chapter is edited', () => {
  it('bumps rev, re-parses the title line and sends a block patch', async () => {
    await start();
    harness!.fixture.write('ch01.md', 'Старое название\n\nПервый абзац.\n\nВторой абзац.\n');
    await waitFor(() => harness!.events.find((event) => event.type === 'chapter:created'));

    harness!.fixture.write('ch01.md', 'Новое название\n\nПервый абзац.\n\nВторой абзац.\n\nТретий абзац.\n');
    const revision = await waitFor(() =>
      harness!.events.find((event) => event.type === 'chapter:revision'),
    );
    if (revision.type !== 'chapter:revision') throw new Error('narrowing');
    expect(revision.data).toMatchObject({
      n: 1,
      rev: 2,
      title: 'Новое название',
      kind: 'edit',
      delta: 'Третий абзац.'.length,
    });
    expect(revision.data.patch).toHaveLength(1);
    expect(revision.data.patch[0]).toMatchObject({ op: 'insert', i: 2, text: 'Третий абзац.' });
    expect(catalog()[0]).toMatchObject({ title: 'Новое название', rev: 2 });
    // Page 1 hears about the count once, not once per write: the number did not move.
    const byline = harness!.events.filter((event) => event.type === 'authors:update');
    expect(byline).toHaveLength(1);
    expect(byline[0]?.data).toMatchObject({ count: 0 });
    expect(typeof (byline[0]?.data as { measuredAt?: unknown }).measuredAt).toBe('string');
  }, 10_000);

  it('emits authors:update only when the count actually changed', async () => {
    let count = 0;
    await start({ authorsCount: () => ({ count, measuredAt: new Date().toISOString() }) });
    harness!.fixture.write('ch02.md', 'Вторая\n\nПервый абзац.\n');
    await waitFor(() => harness!.events.find((event) => event.type === 'chapter:created'));
    expect(harness!.events.filter((event) => event.type === 'authors:update')).toHaveLength(1);

    count = 2;
    harness!.fixture.write('ch02.md', 'Вторая\n\nПервый абзац.\n\nВторой абзац.\n');
    await waitFor(() =>
      harness!.events.find((event) => event.type === 'chapter:revision' && event.data.rev === 2),
    );
    const frames = harness!.events.filter((event) => event.type === 'authors:update');
    expect(frames).toHaveLength(2);
    expect(frames[1]?.data).toMatchObject({ count: 2 });

    // The same count again: the text changed, the byline did not, so no third frame.
    harness!.fixture.write('ch02.md', 'Вторая\n\nПервый абзац.\n\nВторой абзац.\n\nТретий абзац.\n');
    await waitFor(() =>
      harness!.events.find((event) => event.type === 'chapter:revision' && event.data.rev === 3),
    );
    expect(harness!.events.filter((event) => event.type === 'authors:update')).toHaveLength(2);
  }, 10_000);

  it('never blanks a chapter when the file is temporarily empty (§6.2)', async () => {
    await start({ emptyGraceMs: 200 });
    harness!.fixture.write('ch01.md', 'Заголовок\n\nЕдинственный абзац, который нельзя потерять.\n');
    await waitFor(() => harness!.events.find((event) => event.type === 'chapter:created'));
    const before = catalog()[0];

    harness!.fixture.write('ch01.md', '');
    await new Promise((resolve) => setTimeout(resolve, 500));

    const after = catalog()[0];
    expect(after).toMatchObject({ written: true, rev: before?.rev, chars: before?.chars });
    expect(harness!.events.filter((event) => event.type === 'chapter:revision')).toHaveLength(0);
    const row = harness!.fixture.db.prepare('SELECT parse_error FROM chapters WHERE n = 1').get() as {
      parse_error: string | null;
    };
    expect(row.parse_error).toContain('empty write');
  }, 10_000);

  it('publishes a chapter reduced to its basis sentence as one paragraph, still unwritten (BOOK-6)', async () => {
    await start({ emptyGraceMs: 200 });
    harness!.fixture.write('ch01.md', 'Заголовок\n\nАбзац, который потом уберут.\n');
    await waitFor(() => harness!.events.find((event) => event.type === 'chapter:created'));
    const before = catalog()[0];
    expect(before).toMatchObject({ written: true, basis: false });

    harness!.fixture.write('ch01.md', FRAME_FIRST_SENTENCE);
    await waitFor(() =>
      harness!.events
        .slice(1)
        .find((event) => event.type === 'state:updated' && event.data.chapters.written.length === 0),
    );

    const after = catalog()[0];
    expect(after).toMatchObject({ written: false, basis: true, chars: 0, blocks: 1, title: null });
    // The frozen frame is what the reader sees: one block, the sentence itself.
    const blocks = harness!.fixture.db.prepare('SELECT text FROM blocks WHERE chapter = 1').all() as Array<{
      text: string;
    }>;
    expect(blocks.map((block) => block.text)).toEqual([FRAME_FIRST_SENTENCE]);
    // The §6.2 grace must not resurrect the text: this emptiness is the basis, not a save in two steps.
    const row = harness!.fixture.db.prepare('SELECT parse_error FROM chapters WHERE n = 1').get() as {
      parse_error: string | null;
    };
    expect(row.parse_error).toBeNull();
    const state = harness!.state.snapshot();
    expect(state.chapters.written).toEqual([]);
    expect(state.chapters.totalChars).toBe(0);
  }, 10_000);

  it('keeps one block when the basis sentence is rewritten to the same file (BOOK-6)', async () => {
    await start();
    harness!.fixture.write('ch67.md', FRAME_LAST_SENTENCE);
    await waitFor(() =>
      harness!.events.find((event) => event.type === 'state:updated' && event.data.chapters.written.length === 0),
    );
    expect(catalog()[66]).toMatchObject({ n: 67, written: false, basis: true, blocks: 1 });

    // A save that changes nothing visible (a trailing newline) must not duplicate the block.
    harness!.fixture.write('ch67.md', `${FRAME_LAST_SENTENCE}\n`);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const blocks = harness!.fixture.db.prepare('SELECT text FROM blocks WHERE chapter = 67').all() as Array<{
      text: string;
    }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe(FRAME_LAST_SENTENCE);
    expect(harness!.events.filter((event) => event.type === 'chapter:created')).toHaveLength(0);
  }, 10_000);

  it('does not stamp an empty write on a slot that holds only its basis sentence (BOOK-6)', async () => {
    await start();
    harness!.fixture.write('ch67.md', FRAME_LAST_SENTENCE);
    await waitFor(() =>
      harness!.events.find(
        (event) => event.type === 'state:updated' && event.data.chapters.basis.includes(67),
      ),
    );

    harness!.fixture.write('ch67.md', '');
    await new Promise((resolve) => setTimeout(resolve, 400));

    // The frame has no prose to lose: an empty file is just an empty slot, not a torn save.
    const row = harness!.fixture.db.prepare('SELECT parse_error, block_count FROM chapters WHERE n = 67').get() as {
      parse_error: string | null;
      block_count: number;
    };
    expect(row.parse_error).toBeNull();
    expect(row.block_count).toBe(1);
    expect(harness!.events.some((event) => event.type === 'chapter:revision')).toBe(false);
  }, 10_000);

  it('does not publish a first write with zero blocks as a chapter', async () => {
    await start();
    harness!.fixture.write('ch02.md', '');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(harness!.events.filter((event) => event.type === 'chapter:created')).toHaveLength(0);
    expect(catalog()[1]).toMatchObject({ n: 2, written: false, rev: 0 });
  }, 10_000);
});

describe('watcher: a chapter disappears', () => {
  it('removes the projection and says so through state:updated', async () => {
    await start();
    harness!.fixture.write('ch03.md', 'Третья\n\nАбзац третьей главы.\n');
    await waitFor(() => harness!.events.find((event) => event.type === 'chapter:created'));
    const before = harness!.events.length;

    rmSync(join(harness!.fixture.manuscript, 'ch03.md'));
    const stateEvent = await waitFor(() =>
      harness!.events
        .slice(before)
        .find((event) => event.type === 'state:updated' && event.data.chapters.written.length === 0),
    );
    expect(stateEvent.type).toBe('state:updated');
    expect(catalog()[2]).toMatchObject({ n: 3, written: false });
  }, 10_000);
});

describe('watcher: infrastructure faults', () => {
  it('catches up a write that landed between the boot scan and ready', async () => {
    const fixture = createFixture({});
    reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
    fixture.write('ch05.md', 'Пятая\n\nАбзац, написанный во время загрузки.\n');
    const state = new StateService(fixture.db);
    const events: IngestEvent[] = [];
    const watcher = new ManuscriptWatcher({
      db: fixture.db,
      state,
      bookRoot: fixture.root,
      dataDir: fixture.dataDir,
      pollMs: 20,
      stabilityMs: 20,
      coalesceMs: 40,
      emit: (event) => events.push(event),
      log: () => undefined,
    });
    await watcher.start();
    expect(events.find((event) => event.type === 'chapter:created')).toMatchObject({
      data: { n: 5, rev: 1, title: 'Пятая' },
    });
    await watcher.stop();
    fixture.close();
  }, 10_000);

  it('starts on a missing manuscript directory and says so instead of pretending it is empty', async () => {
    const fixture = createFixture({});
    rmSync(fixture.manuscript, { recursive: true, force: true });
    const state = new StateService(fixture.db);
    const watcher = new ManuscriptWatcher({
      db: fixture.db,
      state,
      bookRoot: fixture.root,
      dataDir: fixture.dataDir,
      pollMs: 20,
      stabilityMs: 20,
      coalesceMs: 40,
      emit: () => undefined,
      log: () => undefined,
    });
    await watcher.start();
    expect(watcher.status.missing).toBe(true);
    await watcher.stop();
    fixture.close();
  }, 10_000);

  it('keeps the last text when the whole directory disappears', async () => {
    await start();
    harness!.fixture.write('ch04.md', 'Четвёртая\n\nАбзац четвёртой главы.\n');
    await waitFor(() => harness!.events.find((event) => event.type === 'chapter:created'));

    rmSync(harness!.fixture.manuscript, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(harness!.watcher.status.missing).toBe(true);
    expect(catalog()[3]).toMatchObject({ n: 4, written: true, title: 'Четвёртая' });
  }, 10_000);
});

/** A live `front` lease inside an open ripple: the engine row set, not a mock (§6A.11). */
function seedFrontLease(db: Fixture['db']): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO changes (seq, id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint,
       status, cascade_id, enqueued_at, started_at, attempts)
     VALUES (1, 'chg_f', 'accepted_comment', 1, 'название должно звучать иначе', 1, 'sha', '[]', 'chapter',
       'processing', 'csc_f', ?, ?, 0)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO cascades (id, change_id, status, wave, depth_fwd, depth_bwd, step_count, tokens, budget, opened_at)
     VALUES ('csc_f', 'chg_f', 'open', 2, 0, 1, 2, 0, '{}', ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO leases (id, step_id, change_id, cascade_id, lane, chapter, is_front, kind, session,
       expected_rev, acquired_at, heartbeat_at, expires_at, released_at)
     VALUES ('lea_f', 'stp_f', 'chg_f', 'csc_f', NULL, NULL, 1, 'front', 'fwd', 1, ?, ?, ?, NULL)`,
  ).run(now, now, new Date(Date.now() + 120_000).toISOString());
}

describe('watcher: the first sheet', () => {
  it('accepts an owner hand edit of page 2 and updates both live (BOOK-7)', async () => {
    await start();
    harness!.fixture.write('00-front.md', FRONT_TWO);

    const front = await waitFor(() => harness!.events.find((event) => event.type === 'front:updated'));
    if (front.type !== 'front:updated') throw new Error('narrowing');
    expect(front.data).toMatchObject({
      title: 'Тестовая глава',
      rev: 2,
      previousRev: 1,
    });
    // No lease owns the front: this is the owner's hand edit, so page 2 follows the file.
    expect(front.data.about).toBe(NEW_ABOUT);
    const logged = harness!.fixture.db
      .prepare(`SELECT payload, author_kind, author_label FROM events WHERE kind = 'front.revised' ORDER BY hseq DESC LIMIT 1`)
      .get() as { payload: string; author_kind: string; author_label: string };
    expect(JSON.parse(logged.payload)).toMatchObject({
      titleChanged: true,
      annotationChanged: true,
      aboutSha256: sha256Hex(NEW_ABOUT),
    });
    expect(JSON.parse(logged.payload)).not.toHaveProperty('annotationRejected');
    // The history names the hand edit honestly, with the one wording the book already uses.
    expect(logged.author_kind).toBe('unattributed');
    expect(logged.author_label).toBe('правка вне процесса');
    // A hand edit matches no lease: the site says "draft", never a change it cannot prove.
    expect(front.data.cause).toEqual({ kind: 'draft', changeId: null, cascadeId: null, stepId: null });

    const stateEvent = await waitFor(() =>
      harness!.events.find((event) => event.type === 'state:updated' && event.data.front.rev === 2),
    );
    expect(stateEvent.type).toBe('state:updated');
    expect(harness!.state.snapshot().front.title).toBe('Тестовая глава');
    expect(harness!.state.snapshot().front.about).toBe(NEW_ABOUT);
  }, 10_000);

  it('keeps page 2 frozen while a live front lease owns the write', async () => {
    await start();
    seedFrontLease(harness!.fixture.db);
    harness!.fixture.write('00-front.md', FRONT_TWO);

    const front = await waitFor(() => harness!.events.find((event) => event.type === 'front:updated'));
    if (front.type !== 'front:updated') throw new Error('narrowing');
    expect(front.data.cause).toEqual({
      kind: 'cascade',
      changeId: 'chg_f',
      cascadeId: 'csc_f',
      stepId: 'stp_f',
    });
    // A leased pass may retitle the book; the owner's basis wins over its annotation.
    expect(front.data.title).toBe('Тестовая глава');
    expect(front.data.about).toBe(ABOUT);
    const logged = harness!.fixture.db
      .prepare(`SELECT payload FROM events WHERE kind = 'front.revised' ORDER BY hseq DESC LIMIT 1`)
      .get() as { payload: string };
    expect(JSON.parse(logged.payload)).toMatchObject({ annotationRejected: 'FRONT_ANNOTATION_FROZEN' });
  }, 10_000);

  it('clears the cover title and page 2 when the file is removed', async () => {
    await start();
    rmSync(join(harness!.fixture.manuscript, '00-front.md'));
    const front = await waitFor(() =>
      harness!.events.find(
        (event) => event.type === 'front:updated' && event.data.title === null && event.data.rev === 0,
      ),
    );
    if (front.type !== 'front:updated') throw new Error('narrowing');
    expect(harness!.state.snapshot().front.title).toBeNull();
  }, 10_000);
});
