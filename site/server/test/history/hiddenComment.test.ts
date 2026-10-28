import { afterEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/db/db.ts';
import { readAuthor, readChange } from '../../src/engineState/changes.ts';
import { EngineBridge } from '../../src/engineState/bridge.ts';
import { appendChangeEvent, appendEvent } from '../../src/history/log.ts';
import { countReaderChanges } from '../../src/history/live.ts';
import { readRecord } from '../../src/history/record.ts';
import { StateService } from '../../src/ingest/stateService.ts';
import { createFixture, type Fixture } from '../helpers.ts';
import { seedChange } from './helpers.ts';

/**
 * BOOK-101 — a hidden comment leaves no public record line naming its author.
 *
 * The record prints a person's act literally: `alias` is a column, not a clause inside a
 * sentence. So a filing the operator withdrew (`comments.status = 'hidden'`) must not reach
 * this DTO at all — the change loses its line and the author's name is not in the answer.
 *
 * The same rule decides `history.live`: it counts the changes the record lists, so a history
 * whose only reader change is hidden cannot claim to be live over an empty record (the state
 * BOOK-65 removed).
 */

const NOW = new Date('2026-10-25T12:00:00Z');
const BASE_MS = Date.parse('2026-10-25T09:00:00Z');

let fixture: Fixture | null = null;

afterEach(() => {
  fixture?.close();
  fixture = null;
});

function hideComment(db: Db, commentId: string): void {
  db.prepare("UPDATE comments SET status = 'hidden' WHERE id = ?").run(commentId);
}

/** One change with its clock row — the shape every insert path leaves behind. */
function landed(db: Db, index: number, chapter: number, label: string): { changeId: string; commentId: string } {
  const seeded = seedChange(db, { index, chapter, label });
  appendEvent(db, { kind: 'change.queued', changeId: seeded.changeId, chapter }, BASE_MS + index * 60_000);
  return { changeId: seeded.changeId, commentId: seeded.commentId };
}

describe('a hidden comment’s change has no public line (BOOK-101)', () => {
  it('drops the row and never prints the hidden author’s alias', () => {
    fixture = createFixture();
    const db = fixture.db;
    const visible = landed(db, 1, 8, 'Аня');
    const hidden = landed(db, 2, 9, 'Скрытый Читатель');
    hideComment(db, hidden.commentId);

    const page = readRecord(db);
    expect(page.items.map((item) => item.changeId)).toEqual([visible.changeId]);
    expect(JSON.stringify(page.items)).not.toContain('Скрытый Читатель');
    // The clock is still the book's: the hidden change moved time without adding a line.
    expect(page.lastHseq).toBeGreaterThanOrEqual(page.items[0]?.hseq ?? 0);
  });

  it('leaves the rest of the record intact: the visible row keeps its alias and moment', () => {
    fixture = createFixture();
    const db = fixture.db;
    landed(db, 1, 8, 'Аня');
    const hidden = landed(db, 2, 9, 'Марк');
    hideComment(db, hidden.commentId);

    const [entry] = readRecord(db).items;
    expect(entry).toMatchObject({ chapter: 8, alias: 'Аня', status: 'processing', premise: false });
    expect(entry?.hseq).toBeGreaterThan(0);
  });

  it('hides only the hidden one: an unhidden comment returns its line', () => {
    fixture = createFixture();
    const db = fixture.db;
    const seeded = landed(db, 1, 8, 'Аня');
    hideComment(db, seeded.commentId);
    expect(readRecord(db).items).toEqual([]);

    db.prepare("UPDATE comments SET status = 'accepted' WHERE id = ?").run(seeded.commentId);
    expect(readRecord(db).items.map((item) => item.changeId)).toEqual([seeded.changeId]);
  });
});

describe('`history.live` counts the record it names (BOOK-101)', () => {  it('keeps live false when every reader change is hidden', () => {
    fixture = createFixture();
    const seeded = landed(fixture.db, 1, 8, 'Аня');
    hideComment(fixture.db, seeded.commentId);

    expect(countReaderChanges(fixture.db)).toBe(0);
    // `live === true` with an empty list is the state BOOK-65 removed, so the two read one set.
    const state = new StateService(fixture.db, () => NOW).snapshot();
    expect(state.history).toMatchObject({ live: false, readerChanges: 0, started: true });
  });

  it('turns live off again when the only reader’s comment is hidden', () => {
    fixture = createFixture();
    const seeded = landed(fixture.db, 1, 8, 'Аня');
    const service = new StateService(fixture.db, () => NOW);
    expect(service.snapshot().history).toMatchObject({ live: true, readerChanges: 1 });

    hideComment(fixture.db, seeded.commentId);

    // The cached snapshot is keyed on the same count, so the hidden filing bumps it.
    expect(service.snapshot().history).toMatchObject({ live: false, readerChanges: 0 });
    expect(readRecord(fixture.db).items).toEqual([]);
  });

  it('keeps live true while one visible reader change remains', () => {
    fixture = createFixture();
    const kept = landed(fixture.db, 1, 8, 'Аня');
    const dropped = landed(fixture.db, 2, 9, 'Марк');
    hideComment(fixture.db, dropped.commentId);

    const state = new StateService(fixture.db, () => NOW).snapshot();
    expect(state.history).toMatchObject({ live: true, readerChanges: 1 });
    // The count and the list agree: one visible change, one row, one live history.
    expect(readRecord(fixture.db).items.map((item) => item.changeId)).toEqual([kept.changeId]);
  });
});

describe('a hidden row between two visible ones (BOOK-101)', () => {
  it('leaves the order and the cursor of the visible rows exactly as they were', () => {
    fixture = createFixture();
    const db = fixture.db;
    const oldest = landed(db, 1, 8, 'Аня');
    const hidden = landed(db, 2, 9, 'Скрытый Читатель');
    const newest = landed(db, 3, 10, 'Марк');
    hideComment(db, hidden.commentId);

    // Newest first, by the change's own last entry: the hidden row does not take a place…
    const page = readRecord(db);
    expect(page.items.map((item) => item.changeId)).toEqual([newest.changeId, oldest.changeId]);
    // …and it does not take a slot either: a full page holds two visible rows, not one.
    const first = readRecord(db, { limit: 2 });
    expect(first.items.map((item) => item.changeId)).toEqual([newest.changeId, oldest.changeId]);
    expect(first.nextBefore).toBe(first.items[1]?.hseq);
    // The cursor walks the visible rows only, and ends where the visible record ends.
    const second = readRecord(db, { before: first.nextBefore ?? 0, limit: 2 });
    expect(second.items).toEqual([]);
    expect(second.nextBefore).toBeNull();
    const single = readRecord(db, { limit: 1 });
    expect(single.items.map((item) => item.changeId)).toEqual([newest.changeId]);
    expect(single.nextBefore).toBe(single.items[0]?.hseq);
    const afterSingle = readRecord(db, { before: single.nextBefore ?? 0, limit: 1 });
    expect(afterSingle.items.map((item) => item.changeId)).toEqual([oldest.changeId]);
    // The walk ends after the last visible row, and the hidden one never appears in it.
    const end = readRecord(db, { before: afterSingle.nextBefore ?? 0, limit: 1 });
    expect(end.items).toEqual([]);
    expect(end.nextBefore).toBeNull();
  });
});

describe('the author a public surface prints (BOOK-101)', () => {
  it('is absent for a hidden comment’s change and present for a visible one', () => {
    fixture = createFixture();
    const db = fixture.db;
    const visible = landed(db, 1, 8, 'Аня');
    const hidden = landed(db, 2, 9, 'Скрытый Читатель');
    hideComment(db, hidden.commentId);

    // The one function every public surface reads the name through (`GET /api/changes/:id`,
    // the `change:queued` frame, the decisions tailer).
    expect(readAuthor(db, hidden.commentId)).toBeNull();
    expect(readAuthor(db, visible.commentId)).toBe('Аня');
    // A change with no filing behind it has no author to print, as before.
    expect(readAuthor(db, null)).toBeNull();

    const hiddenCard = readChange(db, hidden.changeId, NOW.getTime());
    const visibleCard = readChange(db, visible.changeId, NOW.getTime());
    expect(hiddenCard?.source).toEqual({ commentId: hidden.commentId, author: null });
    expect(visibleCard?.source).toEqual({ commentId: visible.commentId, author: 'Аня' });
    expect(JSON.stringify(hiddenCard)).not.toContain('Скрытый Читатель');
  });
});

describe('the `change:queued` frame (BOOK-101)', () => {
  it('prints no author for a hidden filing and still prints the visible one’s', () => {
    fixture = createFixture();
    const db = fixture.db;
    const visible = seedChange(db, { index: 1, chapter: 8, label: 'Аня' });
    const hidden = seedChange(db, { index: 2, chapter: 9, label: 'Скрытый Читатель' });
    hideComment(db, hidden.commentId);
    appendChangeEvent(db, hidden.changeId, 'queued', {}, BASE_MS);
    appendChangeEvent(db, visible.changeId, 'queued', {}, BASE_MS + 1_000);

    const frames: Array<{ type: string; data: Record<string, unknown> }> = [];
    const bridge = new EngineBridge({
      db,
      emit: (type, data) => frames.push({ type, data: data as Record<string, unknown> }),
      replay: true,
      progressThrottleMs: 0,
      now: () => NOW.getTime(),
    });
    bridge.prime();
    bridge.tick();
    bridge.stop();

    const queued = frames.filter((frame) => frame.type === 'change:queued');
    expect(queued).toHaveLength(2);
    expect(queued[0]?.data.source).toEqual({ commentId: hidden.commentId, author: null });
    expect(queued[1]?.data.source).toEqual({ commentId: visible.commentId, author: 'Аня' });
    // The withdrawn reader's name is not anywhere in the frame, not just off the source field.
    expect(JSON.stringify(queued[0])).not.toContain('Скрытый Читатель');
  });
});
