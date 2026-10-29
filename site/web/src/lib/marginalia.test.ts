import {
  DISPOSITION_LOCKS,
  FAILED_ATTEMPT_LINE,
  LOCK_LINES,
  type ChangeSummaryDto,
  type CommentDto,
  type DispositionLock,
} from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  changeState,
  changeWord,
  DROPPED_LINES,
  filingConsequence,
  filingMarginalia,
  filingSentence,
  filingState,
  NOTE_SAVED_LINE,
  PREMISE_LINES,
  revisionOf,
  sentenceAt,
  STATE_LINES,
  STATE_WORDS,
} from './marginalia.ts';
import { changeLines as changeLinesFor } from './changeStatus.ts';
import { clampQuote } from './seam.ts';

/**
 * BOOK-90 / BOOK-137 — the state words and the deck under them.
 *
 * One table for a filing, one for a change: every status has exactly one of «ждёт» · «идёт» ·
 * «внесено» · «рассмотрено» · «не принято» (BOOK-189; BOOK-206 removed the author's word), and
 * the second line carries what the word cannot (a refusal, a superseded anchor, a held check,
 * an expired pass, the paperwork mode). The revision object's two rows are resolved on the
 * paragraph's own text, by the same rule the mark uses.
 */

/**
 * A filing with the one fact only a frame can bring (BOOK-206 B1): the scheduled retry. The
 * `changeStatus` field is the DTO's own (`pending`/`processing`), so a terminal one is unspellable.
 */
type FilingOverrides = Partial<CommentDto> & { retryAt?: string | null };

function comment(overrides: FilingOverrides = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K4Q7',
    number: 1,
    chapter: 8,
    anchor: { blockId: 'ch08#aa11bb22', blockIndex: 1, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: 'Свет был включён до меня.',
    interventionKind: 'testimony',
    status: 'new',
    frame: 'untouched',
    premise: false,
    reason: null,
    createdAt: '2026-10-21T12:03:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    refusal: null,
    attempt: null,
    ...overrides,
  } as CommentDto;
}

/** A change summary, only the fields the vocabulary reads. */
function change(overrides: Partial<ChangeSummaryDto> = {}): ChangeSummaryDto {
  return {
    premiseLanded: false,
    sourceCommentId: null,
    id: 'chg_1',
    seq: 4,
    chapter: 8,
    intent: 'оставить одно «слово»',
    premise: false,
    status: 'done',
    frame: 'untouched',
    frameMode: null,
    outcome: 'applied',
    reason: null,
    position: null,
    enqueuedAt: '2026-10-25T12:00:00Z',
    decidedAt: '2026-10-25T12:05:00Z',
    chapters: [8, 7, 9],
    rewritten: [8, 7],
    steps: 3,
    modes: [],
    cascade: null,
    ...overrides,
  };
}

describe('the state words', () => {
  it('are the whole vocabulary, one word per state (BOOK-218)', () => {
    expect(STATE_WORDS).toEqual({
      waiting: 'ждёт',
      reading: 'идёт',
      accepted: 'принято',
      writing: 'главу пишут',
      landed: 'внесено',
      registered: 'рассмотрено',
      held: 'проверяется',
      // BOOK-218: two sinks, one word each — a refusal is `не принято`, whatever door it came
      // through. The sentence on the line is what separates them.
      refused: 'не принято',
      // Our failure is its own word: the filing was never judged, so «не принято» would be a
      // verdict nobody made (owner, 2026-10-29).
      undelivered: 'не дошло',
      dropped: 'снято',
      hidden: 'скрыто',
    });
  });

  it('map every filing status onto exactly one of them, and «accepted» reads the change', () => {
    const table: Array<[CommentDto['status'], string]> = [
      ['new', STATE_WORDS.waiting],
      ['batched', STATE_WORDS.reading],
      ['delivered', STATE_WORDS.reading],
      // BOOK-189: `accepted` is «принято» until the linked change says the machine is writing.
      ['accepted', STATE_WORDS.accepted],
      ['applied', STATE_WORDS.landed],
      // BOOK-137: accepted as paperwork — decided, and nothing was written.
      ['registered', STATE_WORDS.registered],
      // BOOK-206: a legacy `escalated` row (before the boot migration re-opens it) waits like any
      // undecided filing; the author's word is gone.
      ['escalated', STATE_WORDS.waiting],
      // BOOK-218: the text moved under it, or the attempt never landed.
      ['superseded', STATE_WORDS.dropped],
      // BOOK-189: a refusal is a decision of its own.
      ['rejected', STATE_WORDS.refused],
      ['quarantined', STATE_WORDS.held],
      ['expired', STATE_WORDS.dropped],
      ['hidden', STATE_WORDS.hidden],
    ];
    for (const [status, word] of table) expect(filingMarginalia(comment({ status })).word, status).toBe(word);
    // BOOK-189 — `accepted` reads only the two live values the DTO names for `changeStatus`.
    expect(filingState(comment({ status: 'accepted', changeStatus: 'processing' }))).toBe('writing');
    expect(filingState(comment({ status: 'accepted', changeStatus: 'pending' }))).toBe('accepted');
    // BOOK-219 — a receipt on the row is the server's landing fact, ahead of the durable read.
    expect(filingState(comment({ status: 'accepted', applied: { chapter: 8, rev: 4 } }))).toBe('landed');
    expect(filingMarginalia(comment({ status: 'accepted', applied: { chapter: 8, rev: 4 } })).word).toBe('внесено');
    expect(filingState(comment({ status: 'rejected' }))).toBe('refused');
    // A rights refusal heads its row with B's own word, never C's.
    expect(filingMarginalia(comment({ status: 'rejected', refusal: 'rights' })).word).toBe('не принято');
  });

  it('reads a landed and a stopped filing from the server’s status and sentence (BOOK-206 B2)', () => {
    // The server turns a stopped change into `rejected` with its own sentence: the page prints
    // that sentence, and a word the deck already owns — it keeps no copy of the rule itself.
    const stopped = filingMarginalia(
      comment({ status: 'rejected', reason: 'правка остановлена — текст остался прежним' }),
    );
    expect(stopped.word).toBe('не принято');
    expect(stopped.consequence).toBe('правка остановлена — текст остался прежним');
    expect(stopped.consequence).not.toContain('в очереди');
    // A landed change reaches the page as `applied` with the server's receipt.
    const landed = filingMarginalia(comment({ status: 'applied', applied: { chapter: 8, rev: 4 } }));
    expect(landed.word).toBe('внесено');
    expect(landed.consequence).toBe('в главу 8. это четвёртая редакция');
    // The live words stay live: «пишется» names the chapter the machine is writing, and a row
    // the machine has not reached names the chapter's turn (BOOK-218).
    expect(filingMarginalia(comment({ status: 'accepted', changeStatus: 'processing' })).consequence).toBe('');
    expect(filingMarginalia(comment({ status: 'accepted', changeStatus: 'pending' })).consequence).toBe(
      STATE_LINES.accepted,
    );
  });

  it('keeps a premise outside the queue: it waits, and only its first edition is «внесено»', () => {
    expect(filingMarginalia(comment({ premise: true, status: 'accepted' })).word).toBe(STATE_WORDS.accepted);
    expect(filingMarginalia(comment({ premise: true, status: 'applied', applied: { chapter: 5, rev: 1 } })).word).toBe('внесено');
    expect(filingState({ status: 'something' as CommentDto['status'] })).toBe('waiting');
  });

  it('map a change’s status onto the same words', () => {
    const table: Array<[Partial<ChangeSummaryDto>, string]> = [
      [{ status: 'pending' }, STATE_WORDS.reading],
      [{ status: 'processing' }, STATE_WORDS.reading],
      [{ status: 'done' }, STATE_WORDS.landed],
      // BOOK-137: `done` with `outcome: 'registered'` is a document, not an edit of the text.
      [{ status: 'done', outcome: 'registered', frameMode: 'оформление' }, STATE_WORDS.registered],
      [{ status: 'stale' }, STATE_WORDS.waiting],
      [{ status: 'escalated' }, STATE_WORDS.waiting],
      [{ status: 'failed' }, STATE_WORDS.waiting],
      [{ status: 'void', outcome: 'dropped' }, STATE_WORDS.waiting],
      [{ premise: true, status: 'pending' }, STATE_WORDS.waiting],
      [{ premise: true, status: 'done' }, STATE_WORDS.landed],
      [{ premise: true, status: 'void', outcome: 'superseded' }, STATE_WORDS.waiting],
    ];
    for (const [overrides, word] of table) expect(changeWord(change(overrides)), JSON.stringify(overrides)).toBe(word);
    expect(changeState(change({ status: 'done' }))).toBe('landed');
  });
});

describe('the deck’s second line', () => {
  it('says what is still to come or what befell the filing', () => {
    expect(filingConsequence(comment({ status: 'new' }))).toBe(STATE_LINES.waiting);
    expect(filingConsequence(comment({ status: 'batched' }))).toBe(STATE_LINES.reading);
    expect(filingConsequence(comment({ status: 'delivered' }))).toBe(STATE_LINES.reading);
    expect(filingConsequence(comment({ status: 'accepted' }))).toBe(STATE_LINES.accepted);
    expect(filingConsequence(comment({ status: 'accepted', interventionKind: null }))).toBe(STATE_LINES.accepted);
    // BOOK-189 — the machine is at this filing: the chapter it writes, never a queue place.
    expect(filingConsequence(comment({ status: 'accepted', changeStatus: 'processing' }))).toBe('');
    expect(filingConsequence(comment({ status: 'accepted', changeStatus: 'pending' }))).toBe(STATE_LINES.accepted);
    expect(filingConsequence(comment({ status: 'superseded' }))).toBe(DROPPED_LINES.superseded);
    // BOOK-206: a legacy `escalated` row claims no fact — the wait is the whole answer.
    expect(filingConsequence(comment({ status: 'escalated' }))).toBe('');
    // A refusal's line is its public reason; with none, the gate's own sentence.
    expect(filingConsequence(comment({ status: 'rejected' }))).toBe(STATE_WORDS.refused);
    expect(filingConsequence(comment({ status: 'rejected', refusal: 'rights' }))).toBe('не принято');
    expect(filingConsequence(comment({ status: 'rejected', reason: 'вне рамок: форма книги' }))).toBe(
      'вне рамок: форма книги',
    );
    expect(filingConsequence(comment({ status: 'quarantined' }))).toBe(STATE_LINES.held);
    expect(filingConsequence(comment({ status: 'expired' }))).toBe(DROPPED_LINES.expired);
    // «скрыто» is the whole word: no second line.
    expect(filingConsequence(comment({ status: 'hidden' }))).toBe('');
    expect(filingConsequence(comment({ status: 'unknown' as CommentDto['status'] }))).toBe(STATE_LINES.waiting);
  });

  it('names the receipt of a landed intervention, and «замечание сохранено» for a note', () => {
    // BOOK-218 line 10 — one word-free shape on every surface: `в главу 7. это четвёртая
    // редакция`. The state word above already says «внесено».
    expect(filingConsequence(comment({ status: 'applied', applied: { chapter: 7, rev: 4 } }))).toBe(
      'в главу 7. это четвёртая редакция',
    );
    expect(filingConsequence(comment({ status: 'applied', interventionKind: null }))).toBe(NOTE_SAVED_LINE);
    // No receipt was stored (a hand-written fixture): no line at all, and no invented revision.
    expect(filingConsequence(comment({ status: 'applied' }))).toBe('');
  });

  it('says what a paperwork filing was filed as, and that the sentence did not change', () => {
    // The comment row carries no mode: its public one-liner is the one source of it, and a row
    // that named none was filed as the default.
    expect(filingConsequence(comment({ status: 'registered', reason: 'принято как оформление: рамка книги — фраза не меняется' }))).toBe(
      'оформление · фраза не изменилась',
    );
    expect(filingConsequence(comment({ status: 'registered', reason: 'принято как поправка: рамка книги — фраза не меняется' }))).toBe(
      'поправка · фраза не изменилась',
    );
    expect(filingConsequence(comment({ status: 'registered' }))).toBe('оформление · фраза не изменилась');
    // A caller that knows the mode (a change's summary) never has it guessed from the line.
    expect(
      filingConsequence({
        ...comment({ status: 'registered', reason: 'принято как оформление: рамка книги — фраза не меняется' }),
        frameMode: 'расхождение',
      }),
    ).toBe('расхождение · фраза не изменилась');
  });

  it('never prints «внесено» for a paperwork filing, nor «рассмотрено» for a landed one', () => {
    const registered = filingMarginalia(comment({ status: 'registered' }));
    const landed = filingMarginalia(comment({ status: 'applied', applied: { chapter: 5, rev: 1 } }));
    expect(registered.word).toBe('рассмотрено');
    expect(registered.state).toBe('registered');
    expect(landed.word).toBe('внесено');
    expect(landed.state).toBe('landed');
  });

  it('keeps a premise’s whole lifecycle on one honest line', () => {
    expect(filingConsequence(comment({ premise: true, status: 'accepted', chapter: 5 }))).toBe(PREMISE_LINES.pending);
    expect(filingConsequence(comment({ premise: true, status: 'applied', applied: { chapter: 5, rev: 2 } }))).toBe(
      'вошло в первую редакцию главы 5',
    );
    expect(filingConsequence(comment({ premise: true, status: 'rejected' }))).toBe('замысел не взят');
    expect(filingConsequence(comment({ premise: true, status: 'superseded' }))).toBe(PREMISE_LINES.superseded);
  });
});

describe('the revision object’s two rows', () => {
  const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет. На столе лежал лист бумаги.';
  const anchor = (overrides: Partial<CommentDto['anchor']> = {}): CommentDto['anchor'] => ({
    blockId: 'ch08#aa11bb22',
    blockIndex: 1,
    quote: 'Её освещал яркий свет.',
    prefix: 'Я вошёл в пустую комнату. ',
    suffix: ' На столе лежал лист бумаги.',
    resolved: true,
    ...overrides,
  });

  it('prints no «стало» when the sentence at the place is unchanged', () => {
    expect(revisionOf(comment({ anchor: anchor() }), TEXT)).toEqual({
      before: 'Её освещал яркий свет.',
      after: null,
      status: 'same',
    });
  });

  it('resolves «стало» by position when the sentence was rewritten', () => {
    // The wording is gone; the stored context still marks the place.
    const rewritten = 'Я вошёл в пустую комнату. Её освещал тусклый свет. На столе лежал лист бумаги.';
    const revision = revisionOf(comment({ anchor: anchor() }), rewritten);
    expect(revision.status).toBe('changed');
    expect(revision.after).toBe('Её освещал тусклый свет.');
    expect(revision.after).not.toBe(revision.before);
    // Never the reader's suggestion: the applied text is the paragraph's own sentence.
    expect(revision.after).not.toBe('Свет был включён до меня.');
  });

  it('prefers the occurrence whose stored context matches when the wording repeats', () => {
    const repeated = 'Её освещал яркий свет. Долгая пауза. И тут Её освещал яркий свет. Конец.';
    const revision = revisionOf(
      comment({
        anchor: anchor({ prefix: 'Долгая пауза. И тут ', suffix: ' Конец.' }),
      }),
      repeated,
    );
    expect(revision.status).toBe('changed');
    expect(revision.after).toBe('И тут Её освещал яркий свет.');
  });

  it('says the text changed when the anchor no longer resolves, never inventing a sentence', () => {
    expect(revisionOf(comment({ anchor: anchor({ resolved: false }) }), TEXT)).toEqual({
      before: 'Её освещал яркий свет.',
      after: null,
      status: 'unresolved',
    });
    // Resolved, but neither the wording nor the stored context survives: no place to resolve.
    const foreign = 'Совсем другой текст без следа прежнего.';
    expect(revisionOf(comment({ anchor: anchor() }), foreign)).toEqual({
      before: 'Её освещал яркий свет.',
      after: null,
      status: 'unresolved',
    });
    expect(revisionOf(comment({ anchor: anchor({ quote: null }) }), TEXT)).toEqual({
      before: null,
      after: null,
      status: 'unresolved',
    });
  });

  it('refuses a repeated context clause: a clause that repeats is not a place', () => {
    // The stored prefix's tail appears twice and no suffix tells the two apart. Printing the
    // neighbour as «стало» would be a lie, so the place is unresolved.
    const repeated = 'Он вошёл. Он вошёл. Дверь была открыта.';
    expect(
      revisionOf(
        comment({ anchor: anchor({ quote: 'Свет был включён.', prefix: 'Он вошёл. ', suffix: '' }) }),
        repeated,
      ),
    ).toEqual({ before: 'Свет был включён.', after: null, status: 'unresolved' });
  });

  it('picks the repeated clause whose stored suffix matches', () => {
    const repeated = 'Он вошёл. Он вошёл. Дверь была открыта.';
    const revision = revisionOf(
      comment({
        anchor: anchor({ quote: 'Свет был включён.', prefix: 'Он вошёл. ', suffix: ' Дверь была открыта.' }),
      }),
      repeated,
    );
    expect(revision.status).toBe('changed');
    expect(revision.after).toBe('Дверь была открыта.');
    expect(revision.after).not.toBe(revision.before);
  });

  it('does not mistake a clamp for a change: a long sentence keeps its place', () => {
    // Distinct words: the clamped quote occurs once, so the place is unambiguous.
    const sentence = `${Array.from({ length: 80 }, (_, index) => `слово${index}`).join(' ')} конец.`;
    const long = comment({
      anchor: anchor({ quote: clampQuote(sentence), prefix: null, suffix: null }),
    });
    expect(revisionOf(long, sentence)).toEqual({
      before: clampQuote(sentence),
      after: null,
      status: 'same',
    });
  });
});

describe('the sentence a filing stands on', () => {
  const TEXT = 'Я вошёл в пустую комнату. Её освещал тусклый свет.';
  const anchor = (overrides: Partial<CommentDto['anchor']> = {}): CommentDto['anchor'] => ({
    blockId: 'ch08#aa11bb22',
    blockIndex: 1,
    quote: 'Её освещал яркий свет.',
    prefix: 'Я вошёл в пустую комнату. ',
    suffix: null,
    resolved: true,
    ...overrides,
  });

  it('names the place even when the wording has been rewritten', () => {
    expect(sentenceAt(TEXT, anchor())).toBe(26);
  });

  it('is the same place the object reads «стало» from', () => {
    const at = sentenceAt(TEXT, anchor());
    const sentence = TEXT.slice(at ?? 0).split('. ')[0];
    expect(sentence).toBe('Её освещал тусклый свет.');
  });

  it('refuses an unresolved anchor and a place it cannot name', () => {
    expect(sentenceAt(TEXT, anchor({ resolved: false }))).toBeNull();
    expect(sentenceAt(TEXT, anchor({ prefix: null, suffix: null }))).toBeNull();
  });
});

describe('the gate’s word beside the state’s word (BOOK-61)', () => {
  it('gives a hold the hold’s line, not the guard’s taxonomy', () => {
    expect(filingConsequence(comment({ status: 'quarantined' }))).toBe(STATE_LINES.held);
    expect(filingConsequence(comment({ status: 'quarantined' }))).not.toContain('возможная инструкция');
  });

  it('prints B’s fixed sentence as the line, and C’s reason alone', () => {
    // B's sentence is stored with its own word in front of it («не принято: …»); the row already
    // heads the line with that word, so the prefix is stripped and the rule sentence stands once.
    expect(
      filingConsequence(
        comment({ status: 'rejected', refusal: 'rights', reason: 'не принято: пересказ чужого текста без источника' }),
      ),
    ).toBe('пересказ чужого текста без источника');
    // BOOK-189: C's word is the state, so the line is the auditor's reason and never the word
    // twice.
    expect(filingConsequence(comment({ status: 'rejected', refusal: 'auditor', reason: 'вне книги' }))).toBe(
      'вне книги',
    );
    expect(filingConsequence(comment({ status: 'rejected', refusal: 'auditor' }))).toBe('не принято');
    // A rights reason that is the gate's word alone is not the line again: the word is the state.
    expect(filingConsequence(comment({ status: 'rejected', refusal: 'rights', reason: 'не принято' }))).toBe(
      'не принято',
    );
    expect(filingMarginalia(comment({ status: 'rejected', refusal: 'rights', reason: 'не принято' })).word).toBe(
      'не принято',
    );
  });

  it('heads a refusal with its gate’s word, and a hold with «проверяется»', () => {
    // BOOK-189, BOOK-218: a refusal never waits — a hold keeps the person's own word.
    expect(filingMarginalia(comment({ status: 'quarantined', refusal: 'held' })).word).toBe(STATE_WORDS.held);
    expect(filingMarginalia(comment({ status: 'rejected', refusal: 'rights' })).word).toBe('не принято');
    expect(filingMarginalia(comment({ status: 'rejected', refusal: 'auditor' })).word).toBe('не принято');
  });
});

describe('a lock’s own sentence (BOOK-218 line 11)', () => {
  const locked = (lock: DispositionLock): FilingOverrides => ({
    status: 'rejected',
    disposition: 'inadmissible',
    reason: LOCK_LINES[lock],
  });

  it('reads the verdict from the stored line', () => {
    for (const lock of DISPOSITION_LOCKS) {
      expect(filingState(comment(locked(lock))), lock).toBe('refused');
      expect(filingMarginalia(comment(locked(lock))).word, lock).toBe('не принято');
    }
    expect(filingState(comment({ status: 'rejected' }))).toBe('refused');
    expect(filingSentence(comment({ status: 'rejected', disposition: 'as_said' }))).toBe('не принято');
  });

  it.each([
    ['rights', 'не принято: это чужой текст, а чужое мы не переписываем'],
    ['harm', 'не принято: этим можно навредить живому человеку'],
    ['frame', 'не принято: у этой главы есть рамка, и её не сдвигают'],
    ['finale', 'не принято: финал уже назван, его не меняют'],
  ] as const)('says the %s lock’s own line, the verdict word in front', (lock, sentence) => {
    expect(filingSentence(comment(locked(lock)))).toBe(sentence);
    const marginalia = filingMarginalia(comment(locked(lock)));
    expect(marginalia.word).toBe('не принято');
    expect(`не принято: ${marginalia.consequence}`).toBe(sentence);
  });

  it('gives our failure its own word, and never a lock’s sentence', () => {
    const tail = 'мы не смогли проверить текст. это наша ошибка, правка не отклонена — нажмите «повторить»';
    const failed = comment({ status: 'rejected', disposition: 'as_said', reason: `не дошло: ${tail}` });
    expect(filingState(failed)).toBe('undelivered');
    expect(filingMarginalia(failed)).toEqual({ state: 'undelivered', word: 'не дошло', consequence: tail });
    expect(filingSentence(failed)).not.toContain('прочитали как');
    expect(filingSentence(failed)).not.toContain('не принято');
  });
});

describe('a failed attempt and a landed premise', () => {
  it('keeps the filing’s word and says the attempt came back empty', () => {
    const failed = filingMarginalia(comment({ status: 'new', attempt: 'failed' }));
    expect(failed).toEqual({ state: 'waiting', word: STATE_WORDS.waiting, consequence: FAILED_ATTEMPT_LINE });
    // A premise still waiting for its first edition says the same: the lane's attempt did not
    // decide anything about the filing.
    expect(filingMarginalia(comment({ premise: true, status: 'accepted', attempt: 'failed' })).consequence).toBe(
      FAILED_ATTEMPT_LINE,
    );
  });

  it('reads a landed premise as entered, with the edition, whatever the row went on to say', () => {
    const landed = change({ premise: true, premiseLanded: true, status: 'void', outcome: 'dropped', reason: FAILED_ATTEMPT_LINE });
    expect(changeState(landed)).toBe('landed');
    expect(changeWord(landed)).toBe(STATE_WORDS.landed);
    // The failed attempt behind a landed premise is stale news, not the premise's line.
    expect(changeLinesFor(landed).second).toBe('вошло в первую редакцию главы 8');
  });
});
