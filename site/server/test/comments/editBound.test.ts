/**
 * BOOK-DOC-4 rule 1 — one intervention is at most 10 000 characters.
 *
 * The cap is only real when all four guards agree: the raw request bound, the sanitizer, the
 * batch item bound and the `hello` frame. A reader writing in Cyrillic costs ~2 bytes per
 * character, so a 10 000-character intervention is 20 000 bytes — larger than the old 8 KB
 * raw and 8 KB batch caps. These tests therefore run at the **byte** caps, not only at the
 * character cap: the promise the composer shows must be the one the server keeps.
 */

import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { COMMENT_MAX_CHARS, REQUEST_BODY_MAX_BYTES, EDIT_MAX_CHARS, EDIT_RAW_MAX_BYTES } from '@book/shared';

import { createBatch, readBatchLines } from '../../src/feedback/batches.ts';
import { bootComments, commentBody, type Harness } from './helpers.ts';

let harness: Harness | null = null;

async function boot(): Promise<Harness> {
  harness = await bootComments();
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function post(h: Harness, body: unknown) {
  return h.app.inject({ method: 'POST', url: '/api/comments', headers: h.headers(), payload: body as object });
}

function counts(db: Harness['db']): { comments: number; rates: number } {
  return {
    comments: (db.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n,
    rates: (db.prepare('SELECT COUNT(*) AS n FROM rate_events').get() as { n: number }).n,
  };
}

/** 2 bytes per character in UTF-8: the fixture is about bytes, not about prose. */
function cyrillic(length: number): string {
  return 'я'.repeat(length);
}

describe('a reader intervention at the edit bound (BOOK-DOC-4 rule 1)', () => {
  it('accepts 10 000 Cyrillic characters end to end and puts the whole text in the batch', async () => {
    const h = await boot();
    const proposed = cyrillic(EDIT_MAX_CHARS);
    expect(Buffer.byteLength(proposed, 'utf8')).toBe(20_000);

    const response = await post(h, commentBody({ proposedText: proposed }));
    expect(response.statusCode).toBe(201);
    const dto = response.json().comment as { id: string; proposedText: string | null };
    expect(dto.proposedText).toBe(proposed);

    const dir = join(h.fixture.dataDir, 'feedback');
    const batch = createBatch({ db: h.db, dir, now: () => new Date('2026-10-25T12:05:00Z') });
    if ('error' in batch) throw new Error(`the batch was refused: ${batch.error}`);
    expect(batch.ids).toEqual([dto.id]);

    const [item] = readBatchLines(dir, batch.batchId);
    // BOOK-61: a batch line is a `book.filing/v1` envelope, so the values sit under
    // `{value, untrusted:true}` and the id is the envelope's `itemId`.
    expect(item?.itemId).toBe(dto.id);
    expect(item?.proposed.value).toBe(proposed);
    expect(item?.proposed.untrusted).toBe(true);
  });

  it('refuses 10 001 characters with a code and consumes no slot', async () => {
    const h = await boot();
    const before = counts(h.db);
    const response = await post(h, commentBody({ proposedText: cyrillic(EDIT_MAX_CHARS + 1) }));

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'TOO_LONG' });
    expect((response.json() as { message: string }).message).toContain(String(EDIT_MAX_CHARS));
    expect(counts(h.db)).toEqual(before);
  });

  it('refuses a payload past the raw bound with 422, before normalizing it', async () => {
    const h = await boot();
    const before = counts(h.db);
    // 32 770 bytes: just past the edit byte bound, well under the transport bound.
    const payload = cyrillic(EDIT_RAW_MAX_BYTES / 2 + 1);
    expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(EDIT_RAW_MAX_BYTES);

    const response = await post(h, commentBody({ proposedText: payload }));
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'TOO_LONG' });
    expect(counts(h.db)).toEqual(before);
  });

  it('refuses a payload past the transport bound with a public code, not a transport detail', async () => {
    const h = await boot();
    const before = counts(h.db);
    const payload = cyrillic(40_000);
    expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(REQUEST_BODY_MAX_BYTES);

    const response = await post(h, commentBody({ proposedText: payload }));
    // The transport refuses before any handler runs, still with a reader-facing code (§9).
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: 'TOO_LONG' });
    expect((response.json() as { message: string }).message).not.toContain('FST_ERR');
    expect(counts(h.db)).toEqual(before);
  });

  it('keeps the note body at its own 1 200-character bound', async () => {
    const h = await boot();
    const accepted = await post(h, commentBody({ body: cyrillic(COMMENT_MAX_CHARS) }));
    expect(accepted.statusCode).toBe(201);

    h.clock.advance(1_000);
    const refused = await post(h, commentBody({ body: cyrillic(COMMENT_MAX_CHARS + 1) }));
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ code: 'TOO_LONG' });
    expect((refused.json() as { message: string }).message).toContain(String(COMMENT_MAX_CHARS));
  });
});

/**
 * BOOK-57/BOOK-158 — a note is a filing and so is an intervention, and **posting** neither
 * costs the reader the day's edit any more: the daily slot is spent by an accepted filing at
 * triage (BOOK-DOC-4 rule 5), so a refusal or a still-waiting remark costs nothing. What the
 * server must still do at posting is create no change row: the lane is fed by triage from the
 * batch, never by the composer.
 */
describe('posting spends no edit (BOOK-57, BOOK-158)', () => {
  it('a note and an intervention both leave the day’s edit whole', async () => {
    const h = await boot();
    const changes = (): number => (h.db.prepare('SELECT COUNT(*) AS n FROM changes').get() as { n: number }).n;

    const note = await post(h, commentBody({ body: 'в этом абзаце повтор, и он второй за главу' }));
    expect(note.statusCode).toBe(201);
    const noteDto = note.json().comment as { proposedText: string | null; interventionKind: string | null };
    expect(noteDto.proposedText).toBeNull();
    expect(noteDto.interventionKind).toBeNull();
    const afterNote = note.json().remaining as { editsPerDay: number; editsRemaining: number; editsResetAt: string | null };
    expect(afterNote.editsRemaining).toBe(afterNote.editsPerDay);
    expect(note.json().queue).toMatchObject({ depth: 0 });
    expect(changes()).toBe(0);

    // Same day, same identity: the intervention is stored and the day is still whole.
    const intervention = await post(h, commentBody({ proposedText: 'Свидетель видел, как свет включили до него.' }));
    expect(intervention.statusCode).toBe(201);
    expect(intervention.json().remaining).toMatchObject({ editsPerDay: 1, editsRemaining: 1 });
    expect(changes()).toBe(0);
    // Not one edit:key was written: only `feedback.mjs decide accepted` spends the day.
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM rate_events WHERE key LIKE 'edit:%'`).get()).toEqual({ n: 0 });
  });

  it('a refused filing leaves the day whole too', async () => {
    const h = await boot();
    const refused = await post(
      h,
      commentBody({ body: 'Добавь в главу сцену, где Владимир Путин подписывает акт.', proposedText: 'Тестовый абзац.' }),
    );
    expect(refused.statusCode).toBe(201);
    const dto = refused.json().comment as { status: string; revise: { allowed: boolean; blocked: string | null } };
    expect(dto.status).toBe('rejected');
    expect(refused.json().remaining).toMatchObject({ editsPerDay: 1, editsRemaining: 1 });
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM rate_events WHERE key LIKE 'edit:%'`).get()).toEqual({ n: 0 });
  });
});
