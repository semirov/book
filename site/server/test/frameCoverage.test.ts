import { describe, expect, it } from 'vitest';

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { appendChangeEvent } from '../src/history/log.ts';
import { applyChapterFile } from '../src/ingest/applyChapter.ts';
import { applyFrontFile } from '../src/ingest/applyFront.ts';
import { ManuscriptWatcher } from '../src/ingest/watcher.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createFixture, longProse, type Fixture } from './helpers.ts';
import { fileOn, runStubStep } from './engine/helpers.ts';
import { first, engineRig, hubRig, siteRig, T0, type Frame } from './frameRig.ts';

/**
 * BOOK-DOC-84 §2.1 — **one case per row of the frame table** (transport, chapter, change and
 * byline rows here; the pass, filing and engine rows are `frameCoverageEngine.test.ts`): drive
 * the emitter, then assert exactly one frame of that type with the payload's required fields and
 * units.
 */

describe('§2.1 — the transport and the snapshot rows', () => {
  it('#1 hello carries the live block, built by the one builder', async () => {
    const { socket, close } = await hubRig();
    try {
      const hello = first(socket.frames(), 'hello');
      const live = hello.data.live as Record<string, unknown>;
      expect(live).toMatchObject({ passes: [], applied: null });
      expect(live.queue).toEqual({ depth: 0, pending: [] });
      expect(live.filings).toEqual([]);
      expect(live.lane).toEqual({ passesToday: 0, maxPasses: 4, writerAt: null });
      expect(typeof live.at).toBe('string');
    } finally {
      close();
    }
  });

  it('#2 state:snapshot answers a resync and echoes its `since`', async () => {
    const { hub, socket, close } = await hubRig();
    try {
      socket.sent = [];
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'resync', data: { since: 4 } })), false);
      const frames = socket.frames();
      expect(frames.map((frame) => frame.type)).toEqual(['state:snapshot']);
      expect(frames[0]?.data).toMatchObject({ since: 4 });
      expect(frames[0]?.data).toHaveProperty('live');
      void hub;
    } finally {
      close();
    }
  });

  it('#24 error is a state line, not a toast: the code travels', async () => {
    const { socket, close } = await hubRig();
    try {
      socket.sent = [];
      socket.emit('message', Buffer.from('not json'), false);
      const error = first(socket.frames(), 'error');
      expect(error.data).toMatchObject({ code: 'INVALID' });
    } finally {
      close();
    }
  });

  it('#25 pong keeps the gap detector honest and has no surface', async () => {
    const { socket, close } = await hubRig();
    try {
      socket.sent = [];
      socket.emit('message', Buffer.from(JSON.stringify({ type: 'ping', data: { t: 9 } })), false);
      const pong = first(socket.frames(), 'pong');
      expect(pong.data).toMatchObject({ t: 9 });
      expect(typeof pong.data.serverTime).toBe('string');
    } finally {
      close();
    }
  });
});

describe('§2.1 — the chapter rows', () => {
  it('#4 chapter:created for a stepless create, with a fetch hint and no text (ADR-004)', () => {
    const { fixture, frames, bridge } = siteRig();
    try {
      const raw = longProse(['Первый абзац служебной главы.', 'Второй абзац.']);
      applyChapterFile({ db: fixture.db, dataDir: fixture.dataDir, n: 5, raw, mtimeMs: T0, nowMs: T0 });
      bridge.tick();
      const created = first(frames, 'chapter:created');
      expect(created.data).toMatchObject({ n: 5, rev: 1, part: 1, direction: 'forward' });
      expect(created.data.fetch).toEqual({ path: '/api/chapters/5', etag: 'ch05-r1-b0' });
      expect(created.data).not.toHaveProperty('text');
    } finally {
      fixture.close();
    }
  });

  it('#5 chapter:revision for a stepless edit, with its patch and `hseq`', () => {
    const { fixture, frames, bridge } = siteRig();
    try {
      applyChapterFile({
        db: fixture.db,
        dataDir: fixture.dataDir,
        n: 5,
        raw: longProse(['Первый абзац служебной главы.', 'Второй абзац.']),
        mtimeMs: T0,
        nowMs: T0,
      });
      applyChapterFile({
        db: fixture.db,
        dataDir: fixture.dataDir,
        n: 5,
        raw: longProse(['Первый абзац служебной главы.', 'Второй абзац, переписанный.']),
        mtimeMs: T0 + 1_000,
        nowMs: T0 + 1_000,
      });
      bridge.tick();
      const revision = first(frames, 'chapter:revision');
      expect(revision.data).toMatchObject({ n: 5, rev: 2, kind: 'edit' });
      expect(typeof revision.data.hseq).toBe('number');
      expect(revision.data.patchTruncated).toBe(false);
      expect((revision.data.patch as unknown[]).length).toBeGreaterThan(0);
    } finally {
      fixture.close();
    }
  });

  it('#6 chapter:applied is the write: ms clock, span, delta, capped patch', () => {
    const { fixture, frames, bridge } = engineRig();
    try {
      fileOn(fixture, 5);
      const run = runStubStep(fixture, { blocks: ['Первый служебный абзац главы.', 'Второй абзац после прохода.'] });
      bridge.tick();
      const chapter = run?.assignment.chapter ?? 5;
      const applied = first(
        frames.filter((frame) => frame.type === 'chapter:applied' && frame.data.n === chapter),
        'chapter:applied',
      );
      expect(applied.data).toMatchObject({ n: chapter, patchTruncated: false });
      expect(['create', 'edit', 'rewrite']).toContain(String(applied.data.kind));
      // The clock is the write's own wall clock in ms, never `landed.at` (D1).
      expect(applied.data.appliedAt).toBe(Date.parse(String(applied.data.createdAt)));
      expect(Number.isInteger(applied.data.appliedAt)).toBe(true);
      expect((applied.data.span as unknown[]).length).toBeGreaterThan(0);
      expect(applied.data.blocksTouched).toBeGreaterThan(0);
      expect(typeof applied.data.delta).toBe('number');
      expect(typeof applied.data.chars).toBe('number');
      expect(applied.data.cause).toMatchObject({ stepId: expect.any(String) });
    } finally {
      fixture.close();
    }
  });

  it('#6b an unreadable pre-image is `patchTruncated: true` and no span — never a guess', () => {
    const { fixture, frames, bridge } = engineRig();
    try {
      // A chapter that exists (rev 1 from the import) and then a pass over it: the write is rev 2.
      fixture.seedChapter(5, longProse(['Первый служебный абзац главы.']));
      fixture.engine.enqueue({ kind: 'operator', chapter: 5, intent: 'в главе 5 появляется документ о допуске' });
      const run = runStubStep(fixture, { blocks: ['Другой абзац после правки.'] });
      expect(run?.assignment.chapter).toBe(5);
      // The pre-image is gone (retention, a bad path): the frame may not invent a delta.
      const previous = fixture.db
        .prepare('SELECT snapshot FROM revisions WHERE chapter = 5 AND rev = 1')
        .get() as { snapshot: string } | undefined;
      expect(previous).toBeDefined();
      rmSync(join(fixture.dataDir, previous!.snapshot), { force: true });
      bridge.tick();
      const applied = frames.filter((frame) => frame.type === 'chapter:applied' && frame.data.n === 5).at(-1) as Frame;
      expect(applied.data).toMatchObject({ n: 5, rev: 2, patchTruncated: true, span: null, patch: [] });
    } finally {
      fixture.close();
    }
  });

  it('#7 front:updated from front_revisions, with the previous revision', () => {
    const { fixture, frames, bridge } = siteRig();
    try {
      applyFrontFile({
        db: fixture.db,
        dataDir: fixture.dataDir,
        raw: 'Без названия\n\nПервая служебная аннотация для проверки разбора страницы.\n',
        mtimeMs: T0,
        nowMs: T0,
      });
      applyFrontFile({
        db: fixture.db,
        dataDir: fixture.dataDir,
        raw: 'Новое название\n\nПервая служебная аннотация для проверки разбора страницы.\n',
        mtimeMs: T0 + 1_000,
        nowMs: T0 + 1_000,
      });
      bridge.tick();
      const frame = frames.filter((entry) => entry.type === 'front:updated').at(-1) as Frame;
      expect(frame.data).toMatchObject({ title: 'Новое название', rev: 2, previousRev: 1 });
    } finally {
      fixture.close();
    }
  });
});

describe('§2.1 — the byline row (the import path)', () => {
  it('#8 authors:update fires only when the count moves, and carries the measured DTO', async () => {
    const fixture = createFixture({});
    let count = 0;
    const byline = { count, measuredAt: new Date(T0).toISOString() };
    const events: Frame[] = [];
    const watcher = new ManuscriptWatcher({
      db: fixture.db,
      state: new StateService(fixture.db, () => new Date(T0)),
      bookRoot: fixture.root,
      dataDir: fixture.dataDir,
      pollMs: 20,
      stabilityMs: 20,
      coalesceMs: 40,
      emptyGraceMs: 120,
      authorsCount: () => {
        byline.count = count;
        return { ...byline };
      },
      emit: (event) => events.push({ type: event.type, data: event.data as Record<string, unknown> }),
      log: () => undefined,
    });
    try {
      await watcher.start();
      await new Promise((resolve) => setTimeout(resolve, 40));
      count = 2;
      fixture.write('ch05.md', longProse(['Первый абзац служебной главы.']));
      const started = Date.now();
      while (events.filter((frame) => frame.type === 'authors:update').length === 0) {
        if (Date.now() - started > 8_000) throw new Error('no authors:update frame');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const bylineFrames = events.filter((frame) => frame.type === 'authors:update');
      expect(bylineFrames).toHaveLength(1);
      expect(bylineFrames[0]?.data).toMatchObject({ count: 2 });
    } finally {
      await watcher.stop();
      fixture.close();
    }
  }, 15_000);
});

describe('§2.1 — the change rows', () => {
  const change = {
    id: 'chg_cov',
    seq: 3,
    chapter: 9,
    status: 'pending',
    intent: 'ключ теперь у другого человека',
  };

  function insertChange(fixture: Fixture): void {
    fixture.db
      .prepare(
        `INSERT INTO changes (seq, id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint,
           premise, status, relevance, outcome, cascade_id, model, tokens_in, tokens_out, cost_rub, enqueued_at,
           started_at, finished_at, attempts)
         VALUES (?, ?, 'accepted_comment', ?, ?, 1, 'sha', '[]', 'phrase', 0, ?, NULL, NULL, NULL, NULL, 0, 0, 0, ?, NULL, NULL, 0)`,
      )
      .run(change.seq, change.id, change.chapter, change.intent, change.status, new Date(T0).toISOString());
  }

  it('#9 change:queued carries `at` (ms) and the change domain’s `eventSeq`', () => {
    const { fixture, frames, bridge } = siteRig();
    try {
      insertChange(fixture);
      appendChangeEvent(fixture.db, change.id, 'queued', {}, T0 + 2_000);
      bridge.tick();
      const queued = first(frames, 'change:queued');
      expect(queued.data).toMatchObject({ id: change.id, at: T0 + 2_000, queue: { depth: 1, ahead: 0 } });
      expect(Number.isInteger(queued.data.eventSeq)).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it('#10 change:processing carries the claim’s place in line', () => {
    const { fixture, frames, bridge } = siteRig();
    try {
      insertChange(fixture);
      appendChangeEvent(fixture.db, change.id, 'processing', {}, T0 + 1_000);
      bridge.tick();
      const processing = first(frames, 'change:processing');
      expect(processing.data).toMatchObject({ id: change.id, attempt: 1, queue: { ahead: 0 }, at: T0 + 1_000 });
      expect(Number.isInteger(processing.data.eventSeq)).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it('#11 change:adapted publishes the narrowed intent, which is the change’s own text', () => {
    const { fixture, frames, bridge } = siteRig();
    try {
      insertChange(fixture);
      appendChangeEvent(
        fixture.db,
        change.id,
        'adapted',
        { intent: 'ключ теперь у другого человека — один абзац', reason: 'в главе два упоминания' },
        T0 + 2_000,
      );
      bridge.tick();
      const adapted = first(frames, 'change:adapted');
      expect(adapted.data).toMatchObject({
        id: change.id,
        chapter: 9,
        intent: 'ключ теперь у другого человека — один абзац',
        reason: 'в главе два упоминания',
        at: T0 + 2_000,
      });
      expect(Number.isInteger(adapted.data.eventSeq)).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it('#12/#13 change:stale and change:decided carry `at` and `eventSeq`', () => {
    const { fixture, frames, bridge } = siteRig();
    try {
      insertChange(fixture);
      appendChangeEvent(fixture.db, change.id, 'stale', { grade: 'partial' }, T0 + 3_000);
      fixture.db.prepare(`UPDATE changes SET status = 'done', outcome = 'applied', finished_at = ? WHERE id = ?`).run(
        new Date(T0 + 4_000).toISOString(),
        change.id,
      );
      appendChangeEvent(fixture.db, change.id, 'decided', { outcome: 'applied' }, T0 + 4_000);
      bridge.tick();
      const stale = first(frames, 'change:stale');
      expect(stale.data).toMatchObject({ id: change.id, at: T0 + 3_000 });
      const decided = first(frames, 'change:decided');
      expect(decided.data).toMatchObject({ id: change.id, outcome: 'applied', at: T0 + 4_000 });
      expect(Number.isInteger(decided.data.eventSeq)).toBe(true);
    } finally {
      fixture.close();
    }
  });
});

