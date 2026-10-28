/**
 * BOOK-187 — the text's only door: `start`/`land` read rows, `POST /internal/text` quotes them,
 * and `POST /internal/restore` publishes a `restore` revision.
 *
 * The claims are the ones the change makes and nothing else: a landing carries its own text, an
 * empty/short/moved-frame text is refused with the same codes a file got, a second landing of the
 * same text publishes nothing, the prompt route answers rows (never a manuscript), and an undo is
 * a new revision of the old text.
 */

import { describe, expect, it } from 'vitest';

import { FRAME_FIRST_SENTENCE, TOTAL_CHAPTERS, type WriterAssignment } from '@book/shared';

import { buildControl } from '../../src/engine/control.ts';
import { acquireLease } from '../../src/engine/leases.ts';
import * as store from '../../src/engine/store.ts';
import { readChapterRows, writtenChaptersOf } from '../../src/engine/text.ts';
import { sha256Hex } from '../../src/util/hash.ts';
import { createEngineFixture, PIPELINE_MODEL, type Fixture } from './helpers.ts';

const TOKEN = 'text-door-token';

function refusalOf(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    const shaped = error as { code?: string; message?: string };
    return { code: shaped.code ?? 'NO_CODE', message: shaped.message ?? '' };
  }
  return { code: 'NO_REFUSAL', message: '' };
}

/** A prose page above the floor, with the chapter's own title line. */
function page(title: string, marker = ''): string {
  const filler =
    'Служебный абзац для проверки объёма страницы, он не является текстом книги. '.repeat(24).trimEnd();
  return `${title}\n\n${marker.length === 0 ? filler : `${filler} ${marker}`}\n`;
}

function openDraft(fixture: Fixture, chapter: number): WriterAssignment {
  const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
  expect(assignment.chapter).toBe(chapter);
  fixture.engine.start(assignment.leaseId);
  return assignment;
}

describe('land — the text travels in the request (BOOK-187)', () => {
  it('lands a chapter the fixture never had a file for, and the rows are the only copy', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = openDraft(fixture, 1);
      const text = `${FRAME_FIRST_SENTENCE} Я постоял и вышел.\n\n${page('', ' продолжение.')}`;
      const landed = fixture.engine.land(assignment.leaseId, { text: `${FRAME_FIRST_SENTENCE} Я постоял и вышел.\n\n${page('', ' продолжение.')}` });
      expect(landed).toMatchObject({ landed: true, changed: true, revAfter: 1 });

      // What the site serves is what was sent: the row, its blocks and its sha.
      const row = readChapterRows(fixture.db, 1);
      expect(row.exists).toBe(true);
      expect(row.sha256).toBe(sha256Hex(text));
      expect(row.blocks[0]?.text.startsWith(FRAME_FIRST_SENTENCE)).toBe(true);
      expect(writtenChaptersOf(fixture.db)).toEqual(new Set([1]));
    } finally {
      fixture.close();
    }
  });

  it('refuses an empty text, a text below the floor and a moved frame, with the codes a file got', () => {
    const fixture = createEngineFixture({ front: null });
    try {
      const draft = openDraft(fixture, 1);
      // A supplied but prose-less text is «not written», the answer an empty file gave.
      expect(refusalOf(() => fixture.engine.land(draft.leaseId, { text: '' }))).toMatchObject({
        code: 'NOT_WRITTEN',
      });
      expect(refusalOf(() => fixture.engine.land(draft.leaseId, { text: 'Начало\n\n' }))).toMatchObject({
        code: 'NOT_WRITTEN',
      });
      expect(
        refusalOf(() => fixture.engine.land(draft.leaseId, { text: `${FRAME_FIRST_SENTENCE} коротко.\n` })),
      ).toMatchObject({ code: 'CHAPTER_TOO_SHORT' });
      const moved = `${FRAME_FIRST_SENTENCE.replace('яркий', 'тусклый')} Я постоял и вышел.\n\n${page('', 'x')}`;
      expect(refusalOf(() => fixture.engine.land(draft.leaseId, { text: moved }))).toMatchObject({
        code: 'FRAME_CHANGED',
      });
      // Not one refusal published anything.
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM revisions').get()).toEqual({ n: 0 });
      expect(store.getStep(fixture.db, draft.stepId)?.landed_at).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('a second landing of the same text is a no-op, and a moved text drops the old verdicts', () => {
    const fixture = createEngineFixture({ front: null });
    try {
      const draft = openDraft(fixture, 1);
      const text = `${FRAME_FIRST_SENTENCE} Я постоял и вышел.\n\n${page('', 'первый.')}`;
      const first = fixture.engine.land(draft.leaseId, { text });
      expect(first.changed).toBe(true);

      const again = fixture.engine.land(draft.leaseId, { text });
      expect(again).toMatchObject({ landed: true, changed: false, sha: first.sha, revAfter: first.revAfter });
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM revisions').get()).toEqual({ n: 1 });

      // The editor answered the first text; the writer then landed a second one.
      const editor = fixture.engine.next({ role: 'editor', session: 'editor-1' });
      expect(editor).not.toBeNull();
      fixture.engine.verdict(draft.stepId, {
        role: 'editor',
        session: 'editor-1',
        verdict: 'HOLDS',
        findings: [],
        model: PIPELINE_MODEL,
        tokensIn: 1,
        tokensOut: 1,
      });
      const moved = `${FRAME_FIRST_SENTENCE} Я постоял и вышел.\n\n${page('', 'второй.')}`;
      expect(fixture.engine.land(draft.leaseId, { text: moved }).changed).toBe(true);
      expect(store.listVerdicts(fixture.db, draft.stepId)).toEqual([]);
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM revisions').get()).toEqual({ n: 2 });
    } finally {
      fixture.close();
    }
  });

  it('start answers the sha, the chars and the pre-image from the rows', () => {
    const seeded = page('Глава сорок', 'исходный.');
    const fixture = createEngineFixture({ chapters: { 40: seeded } });
    try {
      fixture.seedChapterBlocks(39, 'Глава тридцать девять', ['Соседняя глава.', 'Ещё абзац.']);
      fixture.engine.enqueue({ kind: 'operator', chapter: 40, intent: 'уточнить абзац' });
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      const started = fixture.engine.start(assignment.leaseId);
      const rows = readChapterRows(fixture.db, 40);
      expect(started.sha).toBe(rows.sha256);
      expect(started.chars).toBe(rows.chars);
      const step = store.getStep(fixture.db, assignment.stepId);
      expect(JSON.parse(step?.pre_blocks ?? '[]')).toEqual(
        rows.blocks.map((block) => ({ hash: block.hash, chars: block.text.length })),
      );
    } finally {
      fixture.close();
    }
  });

  it('refuses to start any pass but a draft on a slot that holds only its frame: CHAPTER_EMPTY', () => {
    const fixture = createEngineFixture({ chapters: { 1: FRAME_FIRST_SENTENCE } });
    try {
      // The seed is a basis projection: one paragraph to read, no prose, no `chars` (BOOK-6).
      expect(readChapterRows(fixture.db, 1)).toMatchObject({ exists: true, basis: true, chars: 0 });
      expect(writtenChaptersOf(fixture.db).has(1)).toBe(false);

      store.insertStep(fixture.db, {
        stepId: 'stp_basis',
        cascadeId: null,
        seq: 0,
        wave: 0,
        lane: 'forward',
        pass: 'change',
        chapter: 1,
        boundary: '1',
        seamsIn: '[]',
        revBefore: 0,
        at: new Date(fixture.clock.now()).toISOString(),
      });
      const step = store.getStep(fixture.db, 'stp_basis');
      if (step === undefined) throw new Error('the step vanished');
      const lease = acquireLease(fixture.deps, { step, session: 'w1', expectedRev: 0, changeId: null });
      expect(refusalOf(() => fixture.engine.start(lease.id))).toMatchObject({ code: 'CHAPTER_EMPTY' });
    } finally {
      fixture.close();
    }
  });
});

describe('POST /internal/land — the body limit is the door, not the rule (BOOK-187)', () => {
  it('accepts a 90 KB body and refuses it with the chapter’s own code, never a 413', async () => {
    const fixture = createEngineFixture({ front: null });
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    try {
      const draft = openDraft(fixture, 1);
      // 45 000 characters: over the chapter ceiling (30 000) and over a 64 KB body as UTF-8.
      const text = `${FRAME_FIRST_SENTENCE} ${'а'.repeat(45_000 - FRAME_FIRST_SENTENCE.length - 2)}\n`;
      expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(64 * 1024);
      const answer = await app.inject({
        method: 'POST',
        url: '/internal/land',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { leaseId: draft.leaseId, text },
      });
      // The body fits the door, so the engine answers with its own rule and its own code.
      expect(answer.statusCode).toBe(409);
      expect(answer.json()).toMatchObject({ code: 'CHAPTER_TOO_LONG' });
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM revisions').get()).toEqual({ n: 0 });
    } finally {
      await app.close();
      fixture.close();
    }
  });
});

describe('POST /internal/text — rows only (BOOK-187)', () => {
  it('answers the title, the basis flag, the chars and the body without a title line', async () => {
    const fixture = createEngineFixture({
      chapters: { 40: page('Глава сорок', 'исходный.'), 1: FRAME_FIRST_SENTENCE },
    });
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    try {
      const answer = await app.inject({
        method: 'POST',
        url: '/internal/text',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { chapters: [1, 40, 41] },
      });
      expect(answer.statusCode).toBe(200);
      const data = answer.json().data as {
        chapters: Array<{ n: number; title: string | null; exists: boolean; basis: boolean; chars: number; text: string }>;
      };
      const [first, fortieth, absent] = data.chapters;
      expect(first).toMatchObject({ n: 1, exists: true, basis: true, chars: 0, text: FRAME_FIRST_SENTENCE });
      expect(fortieth).toMatchObject({ n: 40, exists: true, basis: false, title: 'Глава сорок' });
      expect(fortieth?.chars).toBe(readChapterRows(fixture.db, 40).chars);
      // The body is canonical and carries no title line: the prompt prints the title itself.
      expect(fortieth?.text.startsWith('Глава сорок')).toBe(false);
      expect(fortieth?.text).toContain('Служебный абзац для проверки объёма страницы');
      expect(absent).toEqual({ n: 41, title: null, exists: false, basis: false, chars: 0, text: '' });
    } finally {
      await app.close();
      fixture.close();
    }
  });

  it('refuses an empty list, an unknown chapter number and an unauthenticated caller', async () => {
    const fixture = createEngineFixture();
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    try {
      const post = (payload: unknown, token = TOKEN) =>
        app.inject({
          method: 'POST',
          url: '/internal/text',
          headers: { authorization: `Bearer ${token}` },
          payload: payload as Record<string, unknown>,
        });
      expect((await post({ chapters: [] })).statusCode).toBe(400);
      expect((await post({ chapters: [TOTAL_CHAPTERS + 1] })).statusCode).toBe(400);
      expect((await post({ chapters: Array.from({ length: 9 }, (_, index) => index + 1) })).statusCode).toBe(400);
      expect((await post({ chapters: [1] }, 'nope')).statusCode).toBe(401);
    } finally {
      await app.close();
      fixture.close();
    }
  });
});

describe('POST /internal/restore — an undo is a new revision (BOOK-187)', () => {
  it('publishes the old text as a restore revision, and the chapter reads it again', async () => {
    const base = page('Глава сорок', 'исходный.');
    const fixture = createEngineFixture({ chapters: { 40: base } });
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    try {
      // A landed change over the seeded base: revision 2.
      fixture.engine.enqueue({ kind: 'operator', chapter: 40, intent: 'уточнить абзац' });
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      fixture.engine.start(assignment.leaseId);
      fixture.engine.land(assignment.leaseId, { text: page('Глава сорок', 'новый.') });
      expect(readChapterRows(fixture.db, 40).raw).toContain('новый.');

      const answer = await app.inject({
        method: 'POST',
        url: '/internal/restore',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { chapter: 40 },
      });
      expect(answer.statusCode).toBe(200);
      expect(answer.json().data).toEqual({ rev: 3, sha: sha256Hex(base), previousRev: 2 });

      const restored = readChapterRows(fixture.db, 40);
      expect(restored.raw).toBe(base);
      expect(restored.sha256).toBe(sha256Hex(base));
      const cause = fixture.db
        .prepare('SELECT kind, cause_kind, log_note FROM revisions WHERE chapter = 40 ORDER BY rev DESC LIMIT 1')
        .get() as { kind: string; cause_kind: string; log_note: string };
      expect(cause.kind).toBe('restore');
      expect(cause.cause_kind).toBe('restore');
      expect(cause.log_note).toContain('restore of rev 1');
    } finally {
      await app.close();
      fixture.close();
    }
  });

  it('refuses a chapter with no history behind it, and a revision that does not exist', async () => {
    const fixture = createEngineFixture({ chapters: { 40: page('Глава сорок', 'один.') } });
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    try {
      const post = (payload: unknown) =>
        app.inject({
          method: 'POST',
          url: '/internal/restore',
          headers: { authorization: `Bearer ${TOKEN}` },
          payload: payload as Record<string, unknown>,
        });
      const noHistory = await post({ chapter: 40 });
      expect(noHistory.statusCode).toBe(409);
      expect(noHistory.json().code).toBe('REVISION_MISSING');
      expect(noHistory.json().message).toContain('восстанавливать нечего');

      const unknown = await post({ chapter: 40, rev: 9 });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().code).toBe('REVISION_MISSING');

      const unwritten = await post({ chapter: 12 });
      expect(unwritten.statusCode).toBe(409);
      expect(unwritten.json().code).toBe('CHAPTER_MISSING');
    } finally {
      await app.close();
      fixture.close();
    }
  });

  it('leaves the chapter alone when the target revision is the one it already reads', async () => {
    const fixture = createEngineFixture({ chapters: { 40: page('Глава сорок', 'один.') } });
    try {
      const answer = fixture.engine.restore({ chapter: 40, rev: 1 });
      expect(answer).toEqual({ rev: 1, sha: readChapterRows(fixture.db, 40).sha256, previousRev: 1 });
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM revisions').get()).toEqual({ n: 1 });
    } finally {
      fixture.close();
    }
  });
});

describe('land — a caller that sends no text re-lands the rows', () => {
  it('records the landing with the revision the rows already carry, and publishes nothing', () => {
    const seeded = page('Глава сорок', 'исходный.');
    const fixture = createEngineFixture({ chapters: { 40: seeded } });
    try {
      fixture.engine.enqueue({ kind: 'operator', chapter: 40, intent: 'уточнить абзац' });
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      fixture.engine.start(assignment.leaseId);
      const landed = fixture.engine.land(assignment.leaseId);
      expect(landed).toMatchObject({ landed: true, changed: false, revAfter: 1, sha: sha256Hex(seeded) });
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM revisions').get()).toEqual({ n: 1 });
    } finally {
      fixture.close();
    }
  });
});
