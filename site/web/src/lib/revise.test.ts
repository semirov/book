import type { CommentDto, CommentRevise } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  cooldownLine,
  REVISE_ATTEMPT_LIMIT,
  REVISE_BUDGET_LINE,
  REVISE_EXHAUSTED,
  reviseAnchor,
  reviseDraft,
  revisePayload,
  reviseView,
} from './revise.ts';

/**
 * BOOK-158 — the refusal's arithmetic and its words, without a browser.
 *
 * The cooldown is the one number the page must not guess: it is read from `revise.at` against
 * the clock at render, rounded up to whole minutes and never below one. The draft and the
 * payload are the two halves of «исправить»: the strip opens with the filing's own text, and
 * the revision sends words only — the anchor stays the row's.
 */

const NOW = Date.parse('2026-10-28T12:00:00Z');

function revise(overrides: Partial<CommentRevise> = {}): CommentRevise {
  return { allowed: true, at: null, attemptsLeft: 2, closed: false, blocked: null, ...overrides };
}

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_refused',
    chapter: 8,
    anchor: {
      blockId: 'ch08#aa11bb22',
      blockIndex: 2,
      quote: 'Её освещал яркий свет.',
      prefix: 'до ',
      suffix: ' после',
      resolved: true,
    },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: 'Свет был включён до меня.',
    interventionKind: 'testimony',
    status: 'rejected',
    frame: 'untouched',
    premise: false,
    reason: 'вне рамок: не про текст этой главы',
    hint: 'приведите название и дату источника цитаты',
    revise: revise(),
    createdAt: '2026-10-27T12:00:00Z',
    decidedAt: '2026-10-28T11:55:00Z',
    changeId: null,
    applied: null,
    refusal: 'rights',
    attempt: null,
    ...overrides,
  };
}

describe('the cooldown line (BOOK-158)', () => {
  it('counts whole minutes from the refusal’s own end, rounding up', () => {
    expect(cooldownLine(new Date(NOW + 7 * 60_000).toISOString(), NOW)).toBe('можно повторить через 7 минут');
    // Six and a half minutes is seven to a reader who is waiting.
    expect(cooldownLine(new Date(NOW + 6.5 * 60_000).toISOString(), NOW)).toBe('можно повторить через 7 минут');
    expect(cooldownLine(new Date(NOW + 2 * 60_000).toISOString(), NOW)).toBe('можно повторить через 2 минуты');
    expect(cooldownLine(new Date(NOW + 60_000).toISOString(), NOW)).toBe('можно повторить через 1 минуту');
  });

  it('never says zero minutes, and never invents one without a time', () => {
    // A window that already closed, or a clock that runs ahead: one minute, not «через 0».
    expect(cooldownLine(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('можно повторить через 1 минуту');
    expect(cooldownLine(new Date(NOW + 20_000).toISOString(), NOW)).toBe('можно повторить через 1 минуту');
    expect(cooldownLine(null, NOW)).toBe('можно повторить через 1 минуту');
    expect(cooldownLine('не время', NOW)).toBe('можно повторить через 1 минуту');
  });
});

describe('what a filing’s surface is told (BOOK-158)', () => {
  it('opens the door when the server says a revision would be judged now', () => {
    expect(reviseView(comment(), NOW)).toEqual({
      hint: 'приведите название и дату источника цитаты',
      allowed: true,
      blocked: null,
    });
  });

  it('closes it for the cooldown, the filing’s day and the reader’s', () => {
    const at = new Date(NOW + 7 * 60_000).toISOString();
    expect(
      reviseView(comment({ revise: revise({ allowed: false, at, blocked: 'cooldown' }) }), NOW),
    ).toMatchObject({ allowed: false, blocked: 'можно повторить через 7 минут' });

    for (const blocked of ['attempts'] as const) {
      expect(
        reviseView(comment({ revise: revise({ allowed: false, closed: true, blocked }) }), NOW),
      ).toMatchObject({ allowed: false, blocked: REVISE_EXHAUSTED });
      // The block alone is the answer: a server that names it owes the sentence even before its
      // own day counter agrees.
      expect(
        reviseView(comment({ revise: revise({ allowed: false, blocked }) }), NOW),
      ).toMatchObject({ allowed: false, blocked: REVISE_EXHAUSTED });
    }
    // `closed` alone (a day with no tries left) owes the same sentence.
    expect(
      reviseView(comment({ revise: revise({ allowed: false, closed: true, blocked: null }) }), NOW),
    ).toMatchObject({ blocked: REVISE_EXHAUSTED });

    for (const blocked of ['identity', 'network'] as const) {
      expect(
        reviseView(comment({ revise: revise({ allowed: false, blocked }) }), NOW),
      ).toMatchObject({ allowed: false, blocked: REVISE_ATTEMPT_LIMIT });
    }
  });

  it('keeps a held filing’s hint and gives it no door at all', () => {
    const held = comment({ status: 'quarantined', refusal: 'held', hint: 'уберите из текста указания в адрес модели' });
    expect(reviseView(held, NOW)).toEqual({
      hint: 'уберите из текста указания в адрес модели',
      allowed: false,
      blocked: null,
    });
  });

  it('treats a missing revise as not revisable, and says nothing about a limit', () => {
    const older: CommentDto = { ...comment(), revise: undefined };
    expect(reviseView(older, NOW)).toEqual({
      hint: 'приведите название и дату источника цитаты',
      allowed: false,
      blocked: null,
    });
    // The same when the server names no limit at all: a door that is shut without a reason is
    // drawn, and no sentence is invented for it.
    const unnamed: CommentDto = { ...comment(), revise: revise({ allowed: false }) };
    expect(reviseView(unnamed, NOW)).toMatchObject({ allowed: false, blocked: null });
  });

  it('says nothing at all about a filing no gate refused', () => {
    expect(reviseView(comment({ status: 'new', hint: null, reason: null, revise: undefined }), NOW)).toBeNull();
    expect(reviseView(comment({ status: 'applied', hint: null, revise: undefined, applied: { chapter: 8, rev: 2 } }), NOW)).toBeNull();
  });
});

describe('the draft «исправить» writes (BOOK-158)', () => {
  it('opens an intervention with its own wording, kind and place', () => {
    expect(reviseDraft(comment())).toEqual({
      chapter: 8,
      blockId: 'ch08#aa11bb22',
      baseRev: null,
      blockIndex: 2,
      sentence: 'Её освещал яркий свет.',
      kind: 'testimony',
      noteOnly: false,
      body: 'в комнате должен быть свет, но не от лампы',
      proposed: 'Свет был включён до меня.',
      revisesId: 'cmt_refused',
    });
  });

  it('treats a block filing with no kind as a note: one text, no wording field', () => {
    const note = comment({ interventionKind: null, proposedText: null, body: 'тут дважды «слово»' });
    const draft = reviseDraft(note);
    expect(draft).toMatchObject({ noteOnly: true, kind: null, body: 'тут дважды «слово»', proposed: 'тут дважды «слово»' });
  });

  it('fills a premise’s one field from its own body', () => {
    const premise = comment({
      chapter: 65,
      premise: true,
      anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true },
      body: 'смена переходит на ночь',
      proposedText: null,
      interventionKind: null,
    });
    expect(reviseDraft(premise)).toMatchObject({
      chapter: 65,
      blockId: null,
      sentence: '',
      noteOnly: false,
      body: 'смена переходит на ночь',
      proposed: 'смена переходит на ночь',
      revisesId: 'cmt_refused',
    });
  });
});

describe('the anchor and the payload of a revision (BOOK-158)', () => {
  it('anchors the strip on the filing’s own quote, with no revision to claim', () => {
    const anchor = reviseAnchor(comment());
    expect(anchor).toMatchObject({
      blockId: 'ch08#aa11bb22',
      baseRev: null,
      quote: 'Её освещал яркий свет.',
      prefix: 'до ',
      suffix: ' после',
      word: 'Её',
    });
    expect(anchor?.sentence).toEqual({ text: 'Её освещал яркий свет.', start: 0, end: 22 });
  });

  it('has no anchor for a premise or a filing whose paragraph is gone', () => {
    expect(reviseAnchor(comment({ anchor: { ...comment().anchor, blockId: null, quote: null } }))).toBeNull();
    expect(reviseAnchor(comment({ anchor: { ...comment().anchor, quote: null } }))).toBeNull();
    expect(reviseAnchor(comment({ anchor: { ...comment().anchor, quote: '   ' } }))).toBeNull();
  });

  it('fills the affixes it does have, and names no word when the quote holds none', () => {
    const bare = reviseAnchor(
      comment({ anchor: { ...comment().anchor, quote: '— —', prefix: null, suffix: null } }),
    );
    expect(bare).toMatchObject({ prefix: '', suffix: '', word: null, quote: '— —' });
  });

  it('sends the words and the kind, never the anchor', () => {
    const payload = revisePayload(reviseDraft(comment()));
    expect(payload).toEqual({
      body: 'в комнате должен быть свет, но не от лампы',
      proposedText: 'Свет был включён до меня.',
      interventionKind: 'testimony',
    });
    // A revision cannot move the filing: chapter, block, quote and revision are the row's.
    expect(payload).not.toHaveProperty('chapter');
    expect(payload).not.toHaveProperty('blockId');
    expect(payload).not.toHaveProperty('quote');
    expect(payload).not.toHaveProperty('baseRev');
  });

  it('sends a note as one text, with no kind and no wording', () => {
    const note = comment({ interventionKind: null, proposedText: null, body: 'тут дважды «слово»' });
    expect(revisePayload(reviseDraft(note))).toEqual({ body: 'тут дважды «слово»' });
  });

  it('sends the edited text of a premise, and a kindless premise as one text', () => {
    const premise = comment({
      chapter: 65,
      premise: true,
      anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true },
      body: 'смена переходит на ночь',
      proposedText: null,
      interventionKind: null,
    });
    const draft = { ...reviseDraft(premise), proposed: 'смена переходит на вечер' };
    expect(revisePayload(draft)).toEqual({ body: 'смена переходит на вечер' });

    // A premise that was stored with a kind keeps it, and its text travels with it (BOOK-16).
    const withKind = { ...draft, kind: 'document' as const };
    expect(revisePayload(withKind)).toEqual({
      body: 'смена переходит на вечер',
      proposedText: 'смена переходит на вечер',
      interventionKind: 'document',
    });
  });
});

describe('the accounting line (BOOK-158)', () => {
  it('says where the day’s edit is spent, in one sentence', () => {
    expect(REVISE_BUDGET_LINE).toBe(
      'одна правка в сутки списывается только за принятую; попытки считаются отдельно',
    );
  });
});

/**
 * BOOK-174: the door is open on an escalated filing too — its words are the reader's, and a
 * revision withdraws the question from the author's desk. Nothing else changes about the view.
 */
describe('the way back from an escalation (BOOK-174)', () => {
  it('offers the door while the filing waits for the author', () => {
    const view = reviseView(
      comment({ status: 'escalated', refusal: null, reason: 'можно ли оформить это бумагой?', hint: null }),
      NOW,
    );
    expect(view).toEqual({ hint: null, allowed: true, blocked: null });
  });

  it('keeps the cooldown the same: the counters are the filing’s, not the verdict’s', () => {
    const cooling = { allowed: false, at: new Date(NOW + 4 * 60_000).toISOString(), attemptsLeft: 3, closed: false, blocked: 'cooldown' as const };
    expect(reviseView(comment({ status: 'escalated', revise: cooling }), NOW)?.blocked).toBe(
      'можно повторить через 4 минуты',
    );
  });
});
