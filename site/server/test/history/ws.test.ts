import { describe, expect, it } from 'vitest';

import type { HistoryEventFrame } from '@book/shared';

import { EngineBridge } from '../../src/engineState/bridge.ts';
import { appendEvent } from '../../src/history/log.ts';
import { historyFixture, ingest } from './helpers.ts';

describe('history:event on the reader socket (§10.3, §11.10)', () => {
  it('emits one tick per log entry, with a summary and no body', () => {
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
      expect(history[0]).toMatchObject({
        kind: 'chapter.created',
        chapter: 1,
        rev: 1,
        isFront: false,
        author: { kind: 'unattributed', label: 'правка вне процесса' },
      });
      expect(history[0]?.summary).toContain('глава 1 написана');
      expect(JSON.stringify(history[0])).not.toContain('служебный');

      // A second tick with no new facts emits nothing (the cursor is a cursor, not a replay).
      const before = frames.filter((frame) => frame.type === 'history:event').length;
      bridge.tick();
      expect(frames.filter((frame) => frame.type === 'history:event').length).toBe(before);
      bridge.stop();
    } finally {
      fixture.close();
    }
  });

  it('carries a document statement as one frame, built from the log (BOOK-18)', () => {
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
      appendEvent(
        fixture.db,
        {
          kind: 'document.status',
          payload: { document: 'приказ № 4', surface: 'Приказ № 4', chapters: [12, 19, 44] },
        },
        Date.parse('2026-10-25T11:00:00Z'),
      );
      bridge.tick();
      const statement = frames.filter((frame) => frame.type === 'history:event').at(-1)?.data;
      expect(statement).toMatchObject({ kind: 'document.status', chapter: null });
      expect(statement?.summary).toBe('статус документа Приказ № 4 изменён в главах 12, 19, 44');
      bridge.stop();
    } finally {
      fixture.close();
    }
  });
});
