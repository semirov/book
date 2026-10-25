import { describe, expect, it } from 'vitest';

import type { HistoryEventFrame } from '@book/shared';

import { EngineBridge } from '../../src/engineState/bridge.ts';
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
      ingest(fixture, 'ch01.md', 'Первая\n\nПоловик в тамбуре намок насквозь ещё в четверг.');

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
      expect(JSON.stringify(history[0])).not.toContain('половик');

      // A second tick with no new facts emits nothing (the cursor is a cursor, not a replay).
      const before = frames.filter((frame) => frame.type === 'history:event').length;
      bridge.tick();
      expect(frames.filter((frame) => frame.type === 'history:event').length).toBe(before);
      bridge.stop();
    } finally {
      fixture.close();
    }
  });
});
