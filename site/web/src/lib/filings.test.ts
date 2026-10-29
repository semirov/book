import type { ChangeSummaryDto, CommentDto } from '@book/shared';
import { describe, expect, it } from 'vitest';
import {
  attemptsOf,
  earlierAttempts,
  filingAttempt,
  filingInk,
  filingNumber,
  filingQuote,
  filingsForBlock,
  insertFiling,
  isPending,
  isStale,
  landingOf,
  sortFilings,
  staleLine,
  stripFilings,
  threadFilings,
  upsertFiling,
  withDecisionReport,
  wordFilingOf,
  type CommentDecisionFrame,
} from './filings.ts';
import { placeHref } from './place.ts';

/** A filing with the one fact only a frame can bring (BOOK-206 B1). */
type FilingsOverrides = Partial<CommentDto> & {
  id: string;
  createdAt: string;
  retryAt?: string | null;
};

function comment(overrides: FilingsOverrides): CommentDto {
  return {
    chapter: 8,
    anchor: { blockId: 'ch08#aa11bb22', blockIndex: 2, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: 'Свет был включён до меня.',
    interventionKind: 'testimony',
    status: 'new',
    frame: 'untouched',
    premise: false,
    reason: null,
    decidedAt: null,
    changeId: null,
    applied: null,
    refusal: null,
    attempt: null,
    ...overrides,
  } as CommentDto;
}

const NEW = comment({ id: 'cmt_01J9Z8K4Q7', createdAt: '2026-10-21T12:03:00Z' });
const ACCEPTED = comment({
  id: 'cmt_01J9Z8K5AA',
  createdAt: '2026-10-20T09:00:00Z',
  status: 'accepted',
  anchor: { ...NEW.anchor, quote: 'Я вошёл в пустую комнату.' },
});
const APPLIED = comment({ id: 'cmt_01J9Z8K6BB', createdAt: '2026-10-19T09:00:00Z', status: 'applied' });
const STALE = comment({
  id: 'cmt_01J9Z8K7CC',
  createdAt: '2026-10-22T09:00:00Z',
  anchor: { ...NEW.anchor, resolved: false, quote: null },
});

describe('filingInk', () => {
  it('gives every state one of the deck’s words and a rule shape, never colour alone', () => {
    // BOOK-90: the word is the vocabulary's (waiting · working · landed); the shape and the
    // ink stay this table's. `accepted` says the writer's lane — «принято» until its change is
    // in hand, «пишется» while it is — and a refusal says «отклонено»; the fact is on line two.
    expect(filingInk(NEW)).toEqual({ word: 'ждёт', rule: 'dotted', tone: 'quiet' });
    expect(filingInk({ status: 'accepted' })).toEqual({ word: 'принято', rule: 'solid', tone: 'live' });
    expect(filingInk({ status: 'accepted', changeStatus: 'processing' })).toEqual({
      word: 'пишется',
      rule: 'solid',
      tone: 'live',
    });
    expect(filingInk({ status: 'applied' })).toEqual({ word: 'внесено', rule: 'none', tone: 'done' });
    expect(filingInk({ status: 'rejected' })).toEqual({ word: 'отклонено', rule: 'solid', tone: 'stopped' });
    expect(filingInk({ status: 'superseded' }).rule).toBe('solid');
    expect(filingInk({ status: 'batched' }).word).toBe('идёт');
  });

  it('falls back to the quiet wait for a state a build does not know', () => {
    expect(filingInk({ status: 'something' as CommentDto['status'] }).word).toBe('ждёт');
  });

  it('gives a paperwork filing a solid rule and the done ink (BOOK-137)', () => {
    // The sentence did not change, so the mark keeps a rule; the decision is made, so it is done.
    expect(filingInk({ status: 'registered' })).toEqual({ word: 'рассмотрено', rule: 'solid', tone: 'done' });
    expect(isPending({ status: 'registered' })).toBe(false);
  });
});

describe('filingsForBlock', () => {
  it('groups by sentence and keeps the pending filing first', () => {
    const groups = filingsForBlock([ACCEPTED, NEW, STALE], 'ch08#aa11bb22');
    const sameSentence = groups.find((group) => group.quote === 'Её освещал яркий свет.');
    expect(sameSentence?.all.map((item) => item.id)).toEqual([NEW.id]);
  });

  it('shows the newest numeral and the overflow on one sentence', () => {
    const older = comment({ id: 'cmt_01J9Z8K8DD', createdAt: '2026-10-18T09:00:00Z' });
    const latest = comment({ id: 'cmt_01J9Z8K9EE', createdAt: '2026-10-23T09:00:00Z' });
    const [group] = filingsForBlock([older, NEW, latest], 'ch08#aa11bb22');
    expect(group?.number).toBe(filingNumber(latest));
    expect(group?.extra).toBe(2);
    expect(stripFilings(group!).shown).toHaveLength(2);
    expect(stripFilings(group!).more).toBe(1);
  });

  it('marks a stale group and leaves live ones alone', () => {
    const [group] = filingsForBlock([STALE], 'ch08#aa11bb22');
    expect(group?.stale).toBe(true);
    expect(isStale(STALE)).toBe(true);
    expect(isStale(NEW)).toBe(false);
  });

  it('ignores another paragraph’s filings', () => {
    expect(filingsForBlock([NEW], 'ch08#ffffffff')).toEqual([]);
  });
});

describe('sortFilings and the overflow line', () => {
  it('puts pending before decided and newest first inside a group', () => {
    expect(sortFilings([APPLIED, NEW, ACCEPTED]).map((item) => item.id)).toEqual([NEW.id, ACCEPTED.id, APPLIED.id]);
    expect(isPending(NEW)).toBe(true);
    expect(isPending(APPLIED)).toBe(false);
  });

  it('prints the stale line for the paragraph', () => {
    expect(staleLine([STALE])).toBe('1 замечание · абзац изменился');
    expect(staleLine([STALE, { ...STALE, id: 'cmt_01J9Z8KAFF' }])).toBe('2 замечания · абзац изменился');
    expect(staleLine([NEW])).toBeNull();
  });
});

describe('the mark and its quote', () => {
  it('prints a three-character record suffix, never an invented ordinal', () => {
    expect(filingNumber({ id: 'cmt_01J9Z8K4Q7' })).toBe('№4Q7');
    expect(filingNumber({ id: 'ab' })).toBe('№0AB');
  });

  it('shortens a long quote and says so when the paragraph moved', () => {
    expect(filingQuote(NEW)).toBe('Её освещал яркий свет.');
    expect(filingQuote(STALE)).toBe('абзац изменился');
    expect(filingQuote({ ...NEW, anchor: { ...NEW.anchor, quote: 'а'.repeat(200) } })).toHaveLength(120);
  });
});

describe('insertFiling — the posted row enters the feed (BOOK-111)', () => {
  it('inserts in ascending order, at the place the moment asks for', () => {
    const later = comment({ id: 'cmt_later', createdAt: '2026-10-27T18:05:00Z' });
    const earlier = comment({ id: 'cmt_earlier', createdAt: '2026-10-27T18:03:00Z' });
    const posted = comment({ id: 'cmt_posted', createdAt: '2026-10-27T18:04:17Z' });

    const next = insertFiling([earlier, later], posted);
    expect(next?.map((row) => row.id)).toEqual(['cmt_earlier', 'cmt_posted', 'cmt_later']);
    // Appending is the common case: the newest filing lands at the end.
    expect(insertFiling([earlier], later)?.map((row) => row.id)).toEqual(['cmt_earlier', 'cmt_later']);
    expect(insertFiling([], posted)?.map((row) => row.id)).toEqual(['cmt_posted']);
  });

  it('is idempotent: the durable refresh finds the id already there and changes nothing', () => {
    // `null` is the contract — the caller keeps the same array, so no second row and no render.
    expect(insertFiling([NEW], NEW)).toBeNull();
    expect(insertFiling([ACCEPTED, NEW], NEW)).toBeNull();
    // And it does not mutate what it was given.
    const feed = [NEW];
    insertFiling(feed, ACCEPTED);
    expect(feed).toEqual([NEW]);
  });
});

/**
 * BOOK-158 — a revision comes back under the id of the row it revised. The feed must replace
 * that row **in its own place** (its moment decides the order, and a revision does not move the
 * filing), and the very same DTO accepted twice must still cost nothing.
 */
describe('upsertFiling — a revised row keeps its place (BOOK-158)', () => {
  it('replaces the row with the same id, in place and without a second entry', () => {
    const earlier = comment({ id: 'cmt_earlier', createdAt: '2026-10-27T18:03:00Z' });
    const later = comment({ id: 'cmt_later', createdAt: '2026-10-27T18:05:00Z' });
    const revised = { ...later, status: 'new' as const, hint: null, body: 'Переписал: абзац начинается с действия.' };

    const next = upsertFiling([earlier, later], revised);
    expect(next?.map((row) => row.id)).toEqual(['cmt_earlier', 'cmt_later']);
    expect(next?.[1]).toBe(revised);
    // The row it replaced is not in the feed any more: one filing, one entry.
    expect(next).not.toContain(later);
  });

  it('still inserts a row the feed does not hold, and changes nothing for the same DTO', () => {
    const fresh = comment({ id: 'cmt_fresh', createdAt: '2026-10-27T18:04:00Z' });
    expect(upsertFiling([NEW], fresh)?.map((row) => row.id)).toEqual([NEW.id, fresh.id]);
    expect(upsertFiling([NEW], NEW)).toBeNull();
  });
});

/**
 * BOOK-137 — the two derivations the reader's surfaces share: what the thread lists, and where
 * an attempt lives. One filing is one entry, and a premise is never one of the thread's.
 */
describe('one filing, one entry (BOOK-137)', () => {
  const summary = (overrides: Partial<ChangeSummaryDto>) => ({
    premiseLanded: false,
    sourceCommentId: NEW.id,
    id: 'chg_1',
    seq: 1,
    chapter: 8,
    intent: 'оставить одно «слово»',
    premise: false,
    status: 'pending' as const,
    frame: 'untouched' as const,
    frameMode: null,
    outcome: null,
    reason: null,
    position: null,
    enqueuedAt: '2026-10-21T12:04:00Z',
    decidedAt: null,
    chapters: [8],
    rewritten: [],
    steps: 0,
    modes: [],
    cascade: null,
    ...overrides,
  });

  it('lists the thread’s filings without a premise, which belongs to the chapter’s row', () => {
    const premise = comment({ id: 'cmt_premise', createdAt: '2026-10-20T09:00:00Z', premise: true });
    expect(threadFilings([NEW, premise, ACCEPTED]).map((row) => row.id)).toEqual([NEW.id, ACCEPTED.id]);
    expect(threadFilings([])).toEqual([]);
  });

  it('the word’s filing carries its change number, and the record’s own when the window misses it', () => {
    // `№12` is the change's number, unpadded; with no attempt in the window the record keeps
    // its own suffix (`№A7K`) — the schema has no filing sequence to print instead.
    const attempt = summary({ id: 'chg_12', seq: 12 });
    expect(wordFilingOf(NEW, [attempt])).toEqual({
      number: filingNumber(NEW),
      seq: 12,
      state: 'ждёт',
      href: placeHref(NEW),
    });
    expect(wordFilingOf(NEW).seq).toBeNull();
    expect(wordFilingOf({ ...NEW, changeId: 'chg_old' }).seq).toBeNull();
  });

  it('keeps the attempts of one filing in order, and only its own', () => {
    const changes = [
      summary({ id: 'chg_2', seq: 2 }),
      summary({ id: 'chg_1', seq: 1 }),
      summary({ id: 'chg_other', seq: 3, sourceCommentId: 'cmt_elsewhere' }),
      summary({ id: 'chg_author', seq: 4, sourceCommentId: null }),
    ];
    expect(attemptsOf(changes, NEW.id).map((row) => row.id)).toEqual(['chg_1', 'chg_2']);
    // An author's own change has no filing and is never an attempt of one.
    expect(attemptsOf(changes, 'cmt_elsewhere').map((row) => row.id)).toEqual(['chg_other']);
    expect(filingAttempt(NEW, changes)).toEqual({ id: 'chg_2', number: '002', seq: 2 });
    expect(earlierAttempts(NEW, changes).map((row) => row.id)).toEqual(['chg_1']);
    // One attempt has nothing earlier, and no change at all is no link.
    expect(earlierAttempts(NEW, [summary({})])).toEqual([]);
    expect(filingAttempt(NEW, [])).toBeNull();
  });

  it('falls back to the comment’s own changeId when the loaded window misses the attempt', () => {
    // The thread reads the newest page of the lane: an older attempt is not in it, and the row
    // still opens the change — without inventing a number it cannot read.
    const linked = { ...NEW, changeId: 'chg_old' };
    expect(filingAttempt(linked, [])).toEqual({ id: 'chg_old', number: null, seq: null });
    expect(linked.changeId).not.toBeNull();
  });
});

/**
 * BOOK-174 — a `comment:decision` frame carries the reading of the filing it names. It is
 * applied to the row with that id only, and only when it really adds something: a frame about
 * a filing this page does not hold, or one that changes nothing, returns `null` (no render).
 */
describe('the decision frame’s report (BOOK-174)', () => {
  const report = {
    line1: 'прочитано как сказано',
    line2: 'потому что рядом нет предложения, которое от этого станет ложным',
    line3: 'где это в книге: глава 8 · абзац 3 · предложение 1',
  };

  it('carries the report onto the row it names and leaves the others alone', () => {
    const first = comment({ id: 'cmt_A', createdAt: '2026-10-25T12:00:00Z' });
    const second = comment({ id: 'cmt_B', createdAt: '2026-10-25T12:01:00Z' });
    const next = withDecisionReport([first, second], {
      id: 'cmt_A',
      status: 'accepted',
      reason: 'принято',
      decidedAt: '2026-10-25T12:30:00Z',
      disposition: 'as_said',
      report,
    });
    expect(next?.[0]).toMatchObject({ status: 'accepted', reason: 'принято', disposition: 'as_said', report });
    expect(next?.[1]).toBe(second);
  });

  it('answers null when the frame names no row on screen, or adds nothing', () => {
    const row = comment({ id: 'cmt_A', createdAt: '2026-10-25T12:00:00Z' });
    expect(withDecisionReport([row], { id: 'cmt_missing', report })).toBeNull();
    expect(withDecisionReport([row], { id: 'cmt_A' })).toBeNull();
  });
});

/**
 * BOOK-219 — a close that landed the filing's text is a second decision about the same filing:
 * `comment:decision` with `status: 'applied'` and the receipt. The row must move to `applied` in
 * that frame (the open page must not print «ждёт» over a chapter that already holds the text),
 * and the frame must name the chapter whose prose the page has to read again.
 */
describe('the landing frame (BOOK-219)', () => {
  const report = { line1: 'прочитано как сказано', line2: 'потому что так и было', line3: 'глава 8 · абзац 3' };
  const landing: CommentDecisionFrame = {
    id: 'cmt_A',
    chapter: 8,
    status: 'applied',
    reason: 'правка внесена в главу 8',
    decidedAt: '2026-10-25T13:00:00Z',
    changeId: 'chg_landed',
    applied: { chapter: 8, rev: 4 },
    report,
  };

  it('moves the row to applied with its receipt and its reading', () => {
    const row = comment({ id: 'cmt_A', createdAt: '2026-10-25T12:00:00Z', status: 'accepted', changeId: 'chg_old' });
    const next = withDecisionReport([row], landing);
    expect(next?.[0]).toMatchObject({
      id: 'cmt_A',
      status: 'applied',
      reason: 'правка внесена в главу 8',
      decidedAt: '2026-10-25T13:00:00Z',
      changeId: 'chg_landed',
      applied: { chapter: 8, rev: 4 },
      report,
    });
  });

  it('takes the receipt as the last word, including “no receipt”', () => {
    const row = comment({ id: 'cmt_A', createdAt: '2026-10-25T12:00:00Z', status: 'applied', applied: { chapter: 8, rev: 3 } });
    const next = withDecisionReport([row], { id: 'cmt_A', status: 'applied', applied: null });
    // The server derives the receipt; a landing whose chapter row is gone carries none, and the
    // page must not keep printing the number it had.
    expect(next?.[0]?.applied).toBeNull();
  });

  it('names the chapter whose text must be read again — and only for a landing', () => {
    expect(landingOf(landing)).toEqual({ chapter: 8, rev: 4 });
    // Triage's own frames move the record and no text: accepted, refused, or applied without
    // the receipt the server derives.
    expect(landingOf({ ...landing, status: 'accepted', applied: null })).toBeNull();
    expect(landingOf({ ...landing, status: 'rejected' })).toBeNull();
    expect(landingOf({ ...landing, applied: null })).toBeNull();
    expect(landingOf({ ...landing, applied: { chapter: 0, rev: 4 } })).toBeNull();
    expect(landingOf({ ...landing, applied: { chapter: 8, rev: -1 } })).toBeNull();
    expect(landingOf('applied')).toBeNull();
    expect(landingOf(null)).toBeNull();
  });
});

/**
 * BOOK-206 audit B1 — the frame that says the change's next attempt is scheduled. Its only fact
 * is the retry time; the reader's line is the frame's own `reason`, so the row must never keep
 * «в очереди на запись» while a stopped attempt is being retried.
 */
describe('the frame’s scheduled retry (BOOK-206 B1)', () => {
  const row = comment({ id: 'cmt_A', createdAt: '2026-10-25T12:00:00Z', status: 'accepted', changeStatus: 'pending' });

  it('carries the retry onto its own row and stops the row promising a queue place', () => {
    const next = withDecisionReport([row], {
      id: 'cmt_A',
      status: 'accepted',
      reason: 'провайдер не ответил — повтор в 12:05',
      decidedAt: '2026-10-29T12:00:00Z',
      attempt: { state: 'failed', retryAt: '2026-10-29T12:05:00Z' },
    });
    expect(next?.[0]).toMatchObject({ retryAt: '2026-10-29T12:05:00Z', reason: 'провайдер не ответил — повтор в 12:05' });
  });

  it('is idempotent, and a spent attempt clears the retry it carried before', () => {
    const held = withDecisionReport([row], { id: 'cmt_A', attempt: { state: 'failed', retryAt: '2026-10-29T12:05:00Z' } });
    expect(held).not.toBeNull();
    const again = withDecisionReport(held ?? [], { id: 'cmt_A', attempt: { state: 'failed', retryAt: '2026-10-29T12:05:00Z' } });
    expect(again).toBeNull();
    const spent = withDecisionReport(held ?? [], { id: 'cmt_A', attempt: { state: 'spent', retryAt: null } });
    expect(spent?.[0]?.retryAt).toBeNull();
    // A frame that says nothing about the attempt leaves the fact where it was.
    expect(withDecisionReport(held ?? [], { id: 'cmt_A', status: 'accepted' })).toBeNull();
  });
});

/**
 * BOOK-219 — the mark's ink follows the row's own fact: a receipt is a landing, and a stop
 * reaches the page as the server's `rejected` row. Nothing is re-derived from the linked change
 * here, because the server already turned that change into the status.
 */
describe('the mark’s ink for a closed change (BOOK-206 B2)', () => {
  it('paints a landed row as the landing and a stopped one as stopped', () => {
    const landed = comment({
      id: 'cmt_A',
      createdAt: '2026-10-25T12:00:00Z',
      status: 'applied',
      applied: { chapter: 8, rev: 4 },
    });
    expect(filingInk(landed)).toMatchObject({ word: 'внесено', rule: 'none', tone: 'done' });
    // A receipt is the landing fact even on a row whose word has not been refetched yet.
    expect(
      filingInk(comment({ id: 'cmt_A', createdAt: '2026-10-25T12:00:00Z', status: 'accepted', applied: { chapter: 8, rev: 4 } })),
    ).toMatchObject({ word: 'внесено', rule: 'none', tone: 'done' });
    // The server's stopped filing: `rejected`, and the deck's refusal word with the stopped ink.
    const stopped = comment({
      id: 'cmt_A',
      createdAt: '2026-10-25T12:00:00Z',
      status: 'rejected',
      reason: 'правка остановлена — текст остался прежним',
    });
    expect(filingInk(stopped)).toMatchObject({ word: 'отклонено', rule: 'solid', tone: 'stopped' });
    // The live row keeps the live ink and its word.
    expect(
      filingInk(comment({ id: 'cmt_A', createdAt: '2026-10-25T12:00:00Z', status: 'accepted', changeStatus: 'pending' })),
    ).toMatchObject({ word: 'ждёт', rule: 'solid', tone: 'live' });
  });
});
