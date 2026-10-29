import type { Envelope, ServerEventType } from '@book/shared';
import { describe, expect, it, vi } from 'vitest';

import { liveFeedHandler } from './liveFeed.ts';

/**
 * BOOK-206 audit B1 — the frames that move a live record without a decision of their own.
 *
 * The assertion is on the calls the page makes, not on the DOM: a claimed change and a closed
 * change each name the chapter whose filings must be re-read, and a landed pass takes the pair
 * a landing already takes (the chapter's filings, the catalog that makes its slot fetch the
 * prose again, and the edition line). Every other stage is the log's own story.
 */

function handler() {
  const deps = {
    refreshComments: vi.fn(),
    refreshCatalog: vi.fn(),
    noteRevision: vi.fn(),
    noteStage: vi.fn(),
  };
  return { deps, onFrame: liveFeedHandler(deps) };
}

function frame(type: ServerEventType, data: unknown): Envelope<ServerEventType, unknown> {
  return { v: 1, type, seq: 7, ts: '2026-10-29T12:00:00Z', data };
}

const STAGE = {
  passId: 'pass_1',
  chapter: 8,
  stageSeq: 4,
  stage: 'landed',
  at: 1_790_000_000_000,
  actor: { process: 'writer', model: 'deepseek/deepseek-flash' },
  changeId: 'chg_1',
  summary: 'глава 8 переписана',
  span: null,
  tokens: null,
  costUsd: null,
};

describe('the live record’s frames (BOOK-206 B1)', () => {
  it('re-reads the filing’s chapter when the writer claims the change', () => {
    const { deps, onFrame } = handler();
    onFrame(frame('change:processing', { id: 'chg_1', chapter: 8, startedAt: '2026-10-29T12:00:00Z', attempt: 1, relevance: null }));
    expect(deps.refreshComments).toHaveBeenCalledWith(8);
    // A claim is not a landing: no text moved and the edition line is unchanged.
    expect(deps.refreshCatalog).not.toHaveBeenCalled();
    expect(deps.noteRevision).not.toHaveBeenCalled();
  });

  it('re-reads the change’s own chapter when the change closes', () => {
    const { deps, onFrame } = handler();
    onFrame(
      frame('change:decided', {
        id: 'chg_1',
        commentId: 'cmt_A',
        outcome: 'applied',
        reason: null,
        chapters: [8, 9],
        cascade: null,
        relevance: null,
        tokens: { total: 0 },
        decidedAt: '2026-10-29T12:05:00Z',
      }),
    );
    // `chapters[0]` is the change's own chapter (`chaptersOfChange`), where the filing stands.
    expect(deps.refreshComments).toHaveBeenCalledWith(8);
    expect(deps.refreshComments).toHaveBeenCalledTimes(1);
  });

  it('a payload that names no chapter still refreshes the thread', () => {
    const { deps, onFrame } = handler();
    onFrame(
      frame('change:decided', {
        id: 'chg_1',
        commentId: null,
        outcome: 'failed',
        reason: null,
        chapters: [],
        cascade: null,
        relevance: null,
        tokens: { total: 0 },
        decidedAt: '2026-10-29T12:05:00Z',
      }),
    );
    expect(deps.refreshComments).toHaveBeenCalledWith(undefined);
  });

  it('a landed pass re-reads the chapter’s filings, the catalog and the edition line', () => {
    const { deps, onFrame } = handler();
    onFrame(frame('pass:stage', STAGE));
    expect(deps.noteStage).toHaveBeenCalledWith(STAGE);
    expect(deps.refreshComments).toHaveBeenCalledWith(8);
    expect(deps.refreshCatalog).toHaveBeenCalledTimes(1);
    expect(deps.noteRevision).toHaveBeenCalledTimes(1);
  });

  it('every other stage is the log’s own story and reads no prose', () => {
    for (const stage of ['queued', 'read', 'verdict', 'drafting', 'typing', 'refused'] as const) {
      const { deps, onFrame } = handler();
      onFrame(frame('pass:stage', { ...STAGE, stage }));
      expect(deps.noteStage).toHaveBeenCalledTimes(1);
      expect(deps.refreshComments).not.toHaveBeenCalled();
      expect(deps.refreshCatalog).not.toHaveBeenCalled();
      expect(deps.noteRevision).not.toHaveBeenCalled();
    }
  });

  it('leaves frames it does not own alone', () => {
    const { deps, onFrame } = handler();
    onFrame(frame('comment:added', { id: 'cmt_A', chapter: 8 }));
    onFrame(frame('state:updated', {}));
    expect(deps.refreshComments).not.toHaveBeenCalled();
    expect(deps.noteStage).not.toHaveBeenCalled();
  });
});
