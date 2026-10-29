import { describe, expect, it, vi } from 'vitest';

import { decisionFrameHandler } from './decisionFrame.ts';

/**
 * BOOK-219 — one `comment:decision` frame moves the record **and**, for a landing, the text.
 *
 * The page's socket handler is the one place these two facts meet, so the assertion is on the
 * calls it makes: a landing re-reads the catalog (a chapter's `rev` is what makes its slot fetch
 * the prose again) and the edition line besides; a triage accept or a refusal moves the record
 * and leaves the prose alone.
 */

function handler() {
  const deps = {
    noteRecord: vi.fn(),
    noteDecision: vi.fn(),
    refreshComments: vi.fn(),
    refreshCatalog: vi.fn(),
    noteRevision: vi.fn(),
  };
  return { deps, onDecision: decisionFrameHandler(deps) };
}

function frame(data: unknown) {
  return { v: 1 as const, type: 'comment:decision' as const, seq: 7, ts: '2026-10-29T12:00:00Z', data };
}

const LANDED = {
  id: 'cmt_A',
  chapter: 8,
  status: 'applied',
  reason: 'правка внесена в главу 8',
  decidedAt: '2026-10-29T12:00:00Z',
  changeId: 'chg_landed',
  applied: { chapter: 8, rev: 4 },
  report: { line1: 'прочитано как сказано', line2: 'потому что так и было', line3: '' },
};

describe('the comment:decision frame (BOOK-219)', () => {
  it('a landing moves the record and reads the chapter’s text again in the same breath', () => {
    const { deps, onDecision } = handler();
    onDecision(frame(LANDED));

    expect(deps.noteRecord).toHaveBeenCalledWith({ kind: 'frame', type: 'comment:decision', data: LANDED });
    expect(deps.noteDecision).toHaveBeenCalledWith(LANDED);
    expect(deps.refreshComments).toHaveBeenCalledWith(8);
    expect(deps.refreshCatalog).toHaveBeenCalledTimes(1);
    expect(deps.noteRevision).toHaveBeenCalledTimes(1);
  });

  it('an accept or a refusal moves the record only — no chapter’s text was touched', () => {
    for (const status of ['accepted', 'rejected'] as const) {
      const { deps, onDecision } = handler();
      onDecision(frame({ id: 'cmt_A', chapter: 8, status, reason: 'принято', decidedAt: '2026-10-29T12:00:00Z' }));
      expect(deps.noteDecision).toHaveBeenCalledTimes(1);
      expect(deps.refreshComments).toHaveBeenCalledWith(8);
      expect(deps.refreshCatalog).not.toHaveBeenCalled();
      expect(deps.noteRevision).not.toHaveBeenCalled();
    }
  });

  it('a frame without a chapter still reaches the row and the record', () => {
    const { deps, onDecision } = handler();
    onDecision(frame({ id: 'cmt_A', status: 'applied', reason: 'внесено', applied: { chapter: 3, rev: 1 } }));
    expect(deps.noteDecision).toHaveBeenCalledTimes(1);
    expect(deps.refreshComments).toHaveBeenCalledWith(undefined);
    // The receipt names chapter 3, so the text read happens even when `chapter` is absent.
    expect(deps.refreshCatalog).toHaveBeenCalledTimes(1);
  });
});
