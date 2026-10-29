import { STAGE_DEADLINE_MS, type LivePass } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  APPLY_WORD_MS,
  HEAD_APPLYING,
  HEAD_CHECKING,
  HEAD_QUIET,
  HEAD_READING,
  HEAD_WRITING,
  headStatusOf,
} from './headStatus.ts';

/**
 * BOOK-DOC-84 §5/D3 — the head's one word, per stage.
 *
 * The 90 s silence bound is gone: an open gate is real work and the word names it. What is
 * asserted here is the vocabulary and its two exits (a pass past its own deadline, an engine
 * that is gone), with the clock handed in.
 */

const AT = 1_764_000_000_000;

function pass(stage: string, since = AT): LivePass {
  return {
    chapter: 12,
    passId: 'stp_1',
    changeId: null,
    lane: 'forward',
    stage,
    stageSeq: 1,
    since,
    deadlineAt: since + STAGE_DEADLINE_MS,
  };
}

const head = (stage: string, nowMs = AT + 20_000): string | null =>
  headStatusOf({ passes: [pass(stage)], nowMs }).full;

describe('the head’s word, per stage', () => {
  it('reads, writes, checks and applies in the stage’s own name', () => {
    expect(head('queued')).toBe(HEAD_READING);
    expect(head('read')).toBe(HEAD_READING);
    expect(head('drafting')).toBe(HEAD_WRITING);
    expect(head('verdict')).toBe(HEAD_CHECKING);
  });

  it('says «сейчас записывает» for two seconds after the write, not after a stage', () => {
    const appliedAt = AT + 1_000;
    expect(headStatusOf({ passes: [pass('drafting')], appliedAt, nowMs: appliedAt + 1 }).full).toBe(HEAD_APPLYING);
    expect(
      headStatusOf({ passes: [pass('drafting')], appliedAt, nowMs: appliedAt + APPLY_WORD_MS }).full,
    ).toBe(HEAD_WRITING);
  });

  it('applies after a close too, on the same two seconds', () => {
    const closedAt = AT + 5_000;
    expect(headStatusOf({ passes: [], closedAt, nowMs: closedAt + 500 }).full).toBe(HEAD_APPLYING);
    expect(headStatusOf({ passes: [], closedAt, nowMs: closedAt + APPLY_WORD_MS }).kind).toBe('idle');
  });
});

describe('the two exits', () => {
  it('prints nothing at all when no pass is open — idle is not a word', () => {
    const status = headStatusOf({ passes: [], nowMs: AT });
    expect(status.kind).toBe('idle');
    expect(status.full).toBeNull();
  });

  it('goes quiet past the pass’s own deadline, not after 90 s of silence', () => {
    // 300 s of real gate work is still the word.
    expect(headStatusOf({ passes: [pass('verdict')], nowMs: AT + 300_000 }).full).toBe(HEAD_CHECKING);
    expect(headStatusOf({ passes: [pass('verdict')], nowMs: AT + STAGE_DEADLINE_MS + 1 }).full).toBe(HEAD_QUIET);
  });

  it('goes quiet when the engine is down or absent, whatever a stage says', () => {
    for (const status of ['down', 'absent'] as const) {
      const head_ = headStatusOf({ passes: [pass('drafting')], engine: { status }, nowMs: AT + 1_000 });
      expect(head_.kind).toBe('quiet');
      expect(head_.full).toBe(HEAD_QUIET);
    }
  });

  it('drops a pass whose own last stage landed or was refused', () => {
    expect(headStatusOf({ passes: [pass('landed')], nowMs: AT + 10_000 }).kind).toBe('idle');
    expect(headStatusOf({ passes: [pass('refused')], nowMs: AT + 10_000 }).kind).toBe('idle');
  });

  it('prefers a stage frame the page heard after the snapshot', () => {
    const stages = {
      12: [
        {
          passId: 'stp_1',
          chapter: 12,
          stageSeq: 4,
          stage: 'verdict' as const,
          at: AT + 30_000,
          actor: { process: 'writer' as const, model: null },
          changeId: null,
          summary: '',
          span: null,
          tokens: null,
          costUsd: null,
        },
      ],
    };
    const status = headStatusOf({ passes: [pass('drafting', AT)], stages, nowMs: AT + 31_000 });
    expect(status.full).toBe(HEAD_CHECKING);
    // The deadline counts from the stage frame's own moment.
    expect(status.untilMs).toBe(AT + 30_000 + STAGE_DEADLINE_MS);
  });
});
