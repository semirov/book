import type { HistoryEventFrame } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { EngineBridge } from '../../src/engineState/bridge.ts';
import { appendEvent } from '../../src/history/log.ts';
import { historyFixture, ingest } from './helpers.ts';

/**
 * BOOK-102 — the public socket says *that* the clock moved, never what it moved.
 *
 * The frame is a bare tick: `{ hseq, at }`. An event's kind, chapter, author and summary are
 * the machine's own sentences, and the page does not print them; sending them to every open
 * client would narrate what the record (BOOK-65) may not. The client's only reaction is to
 * refetch, which `web/src/appHistoryFrame.dom.test.tsx` proves.
 */

/** The frame's whole vocabulary, in one place: adding a field here is the change under review. */
const FRAME_KEYS = ['at', 'hseq'];

describe('history:event on the reader socket is a bare tick (BOOK-102)', () => {
  it('emits one `{ hseq, at }` frame per log entry and no summary to read', () => {
    const fixture = historyFixture();
    try {
      const frames: Array<{ type: string; data: HistoryEventFrame }> = [];
      const bridge = new EngineBridge({
        db: fixture.db,
        emit: (type, data) => frames.push({ type, data: data as HistoryEventFrame }),
        replay: true,
        progressThrottleMs: 0,
        now: () => Date.parse('2026-10-25T12:00:00Z'),
      });
      bridge.prime();
      ingest(fixture, 'ch01.md', 'Первая\n\nТестовый абзац номер один. Это служебный текст, он не является текстом книги.');

      bridge.tick();
      const history = frames.filter((frame) => frame.type === 'history:event').map((frame) => frame.data);
      expect(history.length).toBeGreaterThan(0);
      // The key set is the whole contract: no kind, no chapter, no rev, no author, no summary.
      expect(Object.keys(history[0] ?? {}).sort()).toEqual(FRAME_KEYS);
      expect(history[0]?.hseq).toBeGreaterThan(0);
      // `at` is the row's own moment, not the frame's clock.
      const row = fixture.db.prepare('SELECT at FROM events WHERE hseq = ?').get(history[0]?.hseq) as {
        at: string;
      };
      expect(history[0]?.at).toBe(row.at);
      // The reader-facing sentence never crosses the wire, and neither does a body.
      expect(JSON.stringify(history)).not.toContain('глава 1 написана');
      expect(JSON.stringify(history)).not.toContain('служебный');

      // A second tick with no new facts emits nothing (the cursor is a cursor, not a replay).
      const before = frames.filter((frame) => frame.type === 'history:event').length;
      bridge.tick();
      expect(frames.filter((frame) => frame.type === 'history:event').length).toBe(before);
      bridge.stop();
    } finally {
      fixture.close();
    }
  });

  it('carries a document statement as a tick with no statement in it (BOOK-18)', () => {
    const fixture = historyFixture();
    try {
      const frames: Array<{ type: string; data: HistoryEventFrame }> = [];
      const bridge = new EngineBridge({
        db: fixture.db,
        emit: (type, data) => frames.push({ type, data: data as HistoryEventFrame }),
        replay: true,
        progressThrottleMs: 0,
        now: () => Date.parse('2026-10-25T12:00:00Z'),
      });
      bridge.prime();
      const hseq = appendEvent(
        fixture.db,
        {
          kind: 'document.status',
          payload: { document: 'приказ № 4', surface: 'Приказ № 4', chapters: [12, 19, 44] },
        },
        Date.parse('2026-10-25T11:00:00Z'),
      );
      bridge.tick();
      const statement = frames.filter((frame) => frame.type === 'history:event').at(-1)?.data;
      // Exactly two keys: the paper's name, its chapters and the sentence stay on the log
      // (`engine/indexNotice.test.ts` reads them through `toHistoryEvent`).
      expect(statement).toEqual({ hseq, at: '2026-10-25T11:00:00Z' });
      expect(Object.keys(statement ?? {}).sort()).toEqual(FRAME_KEYS);
      bridge.stop();
    } finally {
      fixture.close();
    }
  });
});
