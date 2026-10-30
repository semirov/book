// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  claim,
  cleanup,
  comment,
  draw,
  installFrames,
  surface,
  T0,
} from './sentenceTheatreHarness.tsx';

/**
 * BOOK-227 §9.11–§9.13 — the two endings of the renderer: reduced motion keeps every act's end
 * shape and starts nothing, and the overlay's node count is the sentence's lines, never its words.
 */

beforeEach(() => {
  installFrames();
});

afterEach(async () => {
  await cleanup();
});

describe('BOOK-227 — reduced motion', () => {
  it('paints the span mark at once and holds it for min(sweepMs, 2 000)', async () => {
    vi.useFakeTimers();
    claim(T0);
    const host = await draw({ row: comment({ status: 'batched' }), reduced: true });
    // Ten words, sweep = 2 608 ms → the hold is 2 000 ms.
    expect(host.querySelectorAll('.theatre-line')).toHaveLength(2);
    expect(host.querySelectorAll('.theatre-end')).toHaveLength(2);
    expect(host.querySelectorAll<HTMLElement>('.theatre-line')[0]?.style.clipPath).toMatch(/^inset\(0 (?:0|0\.00)px 0 0\)$/u);
    await act(async () => {
      vi.advanceTimersByTime(1_999);
    });
    expect(host.querySelectorAll('.theatre-line')).toHaveLength(2);
    await act(async () => {
      vi.advanceTimersByTime(2);
    });
    // The plain cite afterwards.
    expect(host.querySelectorAll('.theatre-line')).toHaveLength(0);
    expect(surface()?.querySelector('[data-s]')?.getAttribute('data-theatre')).toBeNull();
  });

  it('reads the media query when no override is given', async () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal('matchMedia', matchMedia);
    claim(T0);
    const host = await draw({ row: comment({ status: 'batched' }), nowAt: T0 });
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(host.hasAttribute('data-still')).toBe(true);
    vi.useRealTimers();
  });

  it('no act moves under reduced motion: the spine and the tallies are already whole', async () => {
    const stages = [
      {
        passId: 'stp_1',
        chapter: 1,
        stageSeq: 2,
        stage: 'drafting' as const,
        at: T0,
        actor: { process: 'writer' as const, model: null },
        changeId: 'chg_1',
        summary: 'пишется',
        span: null,
        tokens: null,
        costUsd: null,
      },
    ];
    const host = await draw({
      row: comment({ status: 'accepted', changeStatus: 'processing', decidedAt: new Date(T0 - 100).toISOString() }),
      stages,
      reduced: true,
    });
    expect(host.hasAttribute('data-still')).toBe(true);
    expect(host.querySelector('.theatre-spine')?.getAttribute('data-open')).toBe('true');
  });
});

describe('BOOK-227 — the DOM cost', () => {
  it('is O(lines): at most 18 nodes for a sentence, whatever the chapter’s length', async () => {
    const appliedAt = T0;
    const gates = [1, 2, 3].map((seq) => ({
      passId: 'stp_1',
      chapter: 1,
      stageSeq: seq,
      stage: 'verdict' as const,
      at: appliedAt + seq * 100,
      actor: { process: 'writer' as const, model: null },
      changeId: 'chg_1',
      summary: 'редактор',
      span: null,
      tokens: null,
      costUsd: null,
    }));
    const host = await draw({
      row: comment({ status: 'accepted', decidedAt: new Date(T0 - 1_000).toISOString() }),
      stages: gates,
      nowAt: appliedAt + 1_000,
    });
    const nodes = host.querySelectorAll('*').length;
    expect(nodes).toBeLessThanOrEqual(18);
    expect(host.querySelectorAll('.theatre-tally')).toHaveLength(3);
  });
});
