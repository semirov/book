/**
 * BOOK-174 — the chooser: the four answers tried in order, and the author's door behind them.
 *
 * The ladder is the design, not a preference: `as_said` → `through_paper` → `refused_in_world`
 * → `inadmissible` (only under a lock), and it is **total** (BOOK-206, ADR-045 §5): a failed
 * carrier returns one rung up and the floor is `as_said` on the filing's own block anchor —
 * `escalated` is not in the chooser's codomain any more. The two anti-cheat caps keep «the world
 * refuses» from becoming a template.
 */

import { describe, expect, it } from 'vitest';

import {
  LOCK_LINES,
  READING_LINES,
  READING_PLACES,
  STAMP_MAX_CHARS,
  chainLine,
} from '@book/shared';

import {
  chooseDisposition,
  MAX_IN_WORLD_RUN,
  parseDispositionProposal,
  type ChooseDispositionInput,
} from '../../src/feedback/disposition.ts';

/** The filing's own place: ADR-044's sentence id, and the two numbers the report prints. */
const SENTENCE_ID = 'snt_01M6228MR887YPYF2BDC4ZRKT5';
const BLOCK = 'Он вошёл в регистратуру. Там сидела женщина с бланком. Срок — тридцать дней.';
const ONE_SENTENCE = 'Там сидела женщина с бланком.';
/** Two sentences in one quote: ADR-044 resolved no single sentence for it. */
const TWO_SENTENCES = 'Он вошёл в регистратуру. Там сидела женщина с бланком.';
const WORDING = 'В регистратуре выдают уведомление: срок тридцать дней и подпись.';
/** Five words of the wording, verbatim. */
const KEPT = 'срок тридцать дней и подпись';
const STAMP = 'не соответствует форме';
function input(overrides: Partial<ChooseDispositionInput> = {}): ChooseDispositionInput {
  return {
    chapterIsBasis: false,
    chapter: 12,
    blockText: BLOCK,
    blockIndex: 3,
    sentenceIndex: 1,
    sentenceId: SENTENCE_ID,
    quote: ONE_SENTENCE,
    body: 'В сцене этого некому сказать.',
    proposedText: WORDING,
    rightsVerdict: 'CLEAR',
    guard: null,
    flags: [],
    proposal: {},
    caps: { inWorldInChapterByReader: 0, stampUsedInChapter: false, runBefore: 0 },
    ...overrides,
  };
}

/** A carrier that passes its whole licence: a carrier, five verbatim words, one fact changed. */
function paper(overrides: Partial<ChooseDispositionInput['proposal']> = {}): ChooseDispositionInput {
  return input({
    proposal: { disposition: 'through_paper', carrierKind: 'document', quoteKept: KEPT, factsChanged: 1, ...overrides },
  });
}

/** A complete in-world refusal: the four facts, the stamp, the caps' leave. */
function inWorld(overrides: Partial<ChooseDispositionInput['proposal']> = {}): ChooseDispositionInput {
  return input({
    proposal: {
      disposition: 'refused_in_world',
      establishedFact: 'срок рассмотрения — тридцать дней',
      namedPerson: 'Пётр Ильич',
      namedInstance: 'регистратура',
      cost: 'срок начинается заново',
      stamp: STAMP,
      ...overrides,
    },
  });
}

describe('the ladder — each of the five outcomes is reachable', () => {
  it('as_said: one sentence resolved, nothing established changed — the words stand as said', () => {
    const decision = chooseDisposition(input());
    expect(decision).toMatchObject({
      disposition: 'as_said',
      lock: null,
      carrierKind: null,
      reason: READING_LINES.as_said,
      sentenceId: SENTENCE_ID,
      blockIndex: 3,
      sentenceIndex: 1,
      alternate: false,
    });
    expect(chainLine(decision)).toBe(READING_LINES.as_said);
  });

  it('through_paper: a carrier keeps five verbatim words and changes a fact', () => {
    const decision = chooseDisposition(paper());
    expect(decision).toMatchObject({
      disposition: 'through_paper',
      carrierKind: 'document',
      quoteKept: KEPT,
      sentenceId: SENTENCE_ID,
      // Both plans existed: the report names the one that was declined.
      alternate: true,
    });
    expect(chainLine(decision)).toBe(READING_LINES.through_paper);
  });

  it('refused_in_world: the four facts and the caps let the world answer, the stamp is line 3', () => {
    const decision = chooseDisposition(inWorld());
    expect(decision).toMatchObject({
      disposition: 'refused_in_world',
      quoteKept: STAMP,
      sentenceId: SENTENCE_ID,
      reason: READING_LINES.refused_in_world,
    });
    expect(chainLine(decision)).toBe(READING_LINES.refused_in_world);
  });

  it('inadmissible: every lock answers with its own line and its own alternative', () => {
    const locks = [
      { input: input({ rightsVerdict: 'REFUSED' }), lock: 'rights' },
      { input: input({ guard: 'legal' }), lock: 'harm' },
      { input: input({ flags: ['illegal-content'] }), lock: 'harm' },
      { input: input({ chapterIsBasis: true }), lock: 'frame' },
      { input: input({ proposal: { lock: 'finale' } }), lock: 'finale' },
    ] as const;
    for (const { input: fixture, lock } of locks) {
      const decision = chooseDisposition(fixture);
      expect(decision, lock).toMatchObject({
        disposition: 'inadmissible',
        lock,
        reason: LOCK_LINES[lock],
        // A lock carries its sentence, and nothing that would point at a place in the book.
        carrierKind: null,
        sentenceId: null,
        quoteKept: null,
        blockIndex: null,
        sentenceIndex: null,
      });
      // A lock decides the sentence: one line, its verdict word leading.
      expect(chainLine(decision)).toBe(LOCK_LINES[lock]);
    }
  });

  it('as_said is the floor: a proposal may not refuse, and a quote across two sentences still lands', () => {
    const decision = chooseDisposition(
      input({
        quote: TWO_SENTENCES,
        sentenceId: null,
        sentenceIndex: null,
        proposal: { disposition: 'refused_in_world' },
      }),
    );
    // No carrier and no resolved sentence: the words are still read as said, on the block anchor
    // they were filed against. A filing never waits for a person (ADR-045 §5).
    expect(decision).toMatchObject({
      disposition: 'as_said',
      lock: null,
      sentenceId: null,
      carrierKind: null,
    });
    // The reading needs no anchor any more: one line says what was read, not where it sits.
    expect(chainLine(decision)).toBe(READING_LINES.as_said);
  });
});

describe('one rung up — a failed carrier never falls to a bin', () => {
  it('returns to as_said when the kept fragment is shorter than five words', () => {
    const decision = chooseDisposition(paper({ quoteKept: 'тридцать дней' }));
    expect(decision.disposition).toBe('as_said');
    expect(decision.carrierKind).toBeNull();
  });

  it('returns to as_said when the kept fragment is not verbatim', () => {
    const decision = chooseDisposition(paper({ quoteKept: 'срок тридцать дней и подпись автора' }));
    expect(decision.disposition).toBe('as_said');
  });

  it('returns to as_said when the carrier is not one of the six', () => {
    const decision = chooseDisposition(
      paper({ carrierKind: 'letter' as unknown as ChooseDispositionInput['proposal']['carrierKind'] }),
    );
    expect(decision.disposition).toBe('as_said');
  });

  it('returns to as_said when the document changes no fact', () => {
    const decision = chooseDisposition(paper({ factsChanged: 0 }));
    expect(decision.disposition).toBe('as_said');
  });

  it('returns to as_said when as_said fails and the carrier is short: the floor, never a bin', () => {
    const decision = chooseDisposition(
      input({
        quote: TWO_SENTENCES,
        sentenceId: null,
        sentenceIndex: null,
        proposal: { disposition: 'through_paper', carrierKind: 'document', quoteKept: 'тридцать дней', factsChanged: 1 },
      }),
    );
    expect(decision.disposition).toBe('as_said');
    expect(decision.sentenceId).toBeNull();
  });
});

describe('one line per outcome (BOOK-218)', () => {
  it('refuses an overlong stamp: the refusal is not licensed and the reading goes one rung up', () => {
    const stamp = 'не соответствует форме '.repeat(14).trim(); // 300 characters
    expect(stamp.length).toBeGreaterThan(STAMP_MAX_CHARS);
    const decision = chooseDisposition(inWorld({ stamp }));
    expect(decision.disposition).not.toBe('refused_in_world');
    // No carrier to fall back on → the words stand as said, never a refusal with an unreadable line.
    expect(decision.disposition).toBe('as_said');
    expect(decision.quoteKept).toBeNull();
  });

  it('formats every decision as exactly one line, with no code and no second verdict', () => {
    const decisions = [
      chooseDisposition(input()),
      chooseDisposition(paper()),
      chooseDisposition(inWorld()),
      chooseDisposition(input({ rightsVerdict: 'REFUSED' })),
      chooseDisposition(input({ quote: TWO_SENTENCES, proposal: { disposition: 'refused_in_world' } })),
    ];
    for (const decision of decisions) {
      const line = chainLine(decision);
      expect(line.length).toBeGreaterThan(0);
      // One sentence: no line break, no second verdict word in the middle.
      expect(line).not.toContain('\n');
      expect(line).not.toMatch(/[A-Z_]{4,}/u);
      expect(line.match(/не дошло|не принято|прочитали как/gu) ?? []).toHaveLength(1);
    }
  });
});

describe('the anti-cheat caps of an in-world refusal', () => {
  it('returns one rung up to through_paper when this reader already refused in this chapter', () => {
    const fixture = inWorld();
    const decision = chooseDisposition({
      ...fixture,
      proposedText: WORDING,
      proposal: { ...fixture.proposal, carrierKind: 'document', quoteKept: KEPT, factsChanged: 1 },
      caps: { inWorldInChapterByReader: 1, stampUsedInChapter: false, runBefore: 0 },
    });
    expect(decision.disposition).toBe('through_paper');
  });

  it('returns one rung up when the same stamp already stands in the chapter', () => {
    // The stamp cap is the input, not the proposal: the same formula twice would be a template.
    const twice = chooseDisposition({
      ...inWorld(),
      caps: { inWorldInChapterByReader: 0, stampUsedInChapter: true, runBefore: 0 },
    });
    expect(twice.disposition).not.toBe('refused_in_world');
    // With no carrier to fall back on, the words stand as said — never a bin.
    expect(twice.disposition).toBe('as_said');
  });

  it('converts the third in a row: two behind it is the last that may pass', () => {
    const second = chooseDisposition(inWorld());
    expect(second.disposition).toBe('refused_in_world');
    const third = chooseDisposition({
      ...inWorld({ carrierKind: 'document', quoteKept: KEPT, factsChanged: 1 }),
      caps: { inWorldInChapterByReader: 0, stampUsedInChapter: false, runBefore: MAX_IN_WORLD_RUN },
    });
    expect(third.disposition).toBe('through_paper');
  });

  it('carries the paper alternative when the refusal is capped but a carrier is named', () => {
    const third = chooseDisposition({
      ...inWorld({ carrierKind: 'speech', quoteKept: KEPT, factsChanged: 2 }),
      caps: { inWorldInChapterByReader: 0, stampUsedInChapter: false, runBefore: MAX_IN_WORLD_RUN },
    });
    expect(third).toMatchObject({ disposition: 'through_paper', carrierKind: 'speech' });
  });
});

describe('the reading’s one form and its closed place', () => {
  it('keeps the declined plan as a field and never as a second line', () => {
    const both = chooseDisposition(paper());
    expect(both.alternate).toBe(true);
    expect(chainLine(both)).toBe(READING_LINES.through_paper);

    const unresolved = chooseDisposition(
      input({
        quote: TWO_SENTENCES,
        sentenceId: null,
        sentenceIndex: null,
        proposal: { disposition: 'through_paper', carrierKind: 'document', quoteKept: KEPT, factsChanged: 1 },
      }),
    );
    expect(unresolved.alternate).toBe(false);
    expect(chainLine(unresolved)).toBe(READING_LINES.through_paper);
  });

  it('names the place the row carries, and the plain document when it carries none', () => {
    expect(chainLine({ disposition: 'through_paper', lock: null, carrierKind: 'registry_discrepancy' })).toBe(
      'прочитали как бумагу — в сцене это некому сказать, поэтому слово ушло в запись регистратуры',
    );
    expect(chainLine({ disposition: 'through_paper', lock: null, carrierKind: null })).toBe(
      READING_LINES.through_paper,
    );
  });

  it('has one closed line per accepted reading and one place per carrier', () => {
    expect(Object.values(READING_LINES)).toEqual([
      'прочитали как сказано — ваши слова остались в этом самом предложении',
      'прочитали как бумагу — в сцене это некому сказать, поэтому слово ушло в документ',
      'прочитали как ответ мира — в книге это уже установлено, и миру остаётся только ответить',
    ]);
    expect(Object.values(READING_PLACES)).toEqual([
      'в документ',
      'в чью-то реплику',
      'в запись регистратуры',
      'в предмет с номером',
      'в шутку, которую никто не подхватил',
      'в анекдот по протоколу',
    ]);
  });
});

describe('as_said’s own exclusions', () => {
  it('fails when the filing changes a number that already stands in the block', () => {
    // «тридцать» is not a digit, so the token that bites is a number the block already has.
    const fresh = chooseDisposition(
      input({ body: 'Срок — 30 дней.', proposedText: 'Срок — 30 дней, не больше.' }),
    );
    // The block says «тридцать», not «30»: the token is new, so nothing established is changed.
    expect(fresh.disposition).toBe('as_said');
    const stored = chooseDisposition(
      input({
        blockText: 'Срок — 30 дней. Он вошёл.',
        quote: 'Срок — 30 дней.',
        body: 'Срок — 30 дней, и всё.',
        proposedText: null,
      }),
    );
    // A rewritten digit with no carrier fails `as_said` — and there is nothing above it, so the
    // floor answers: read as said, against the block. Never a fifth state (ADR-045 §5).
    expect(stored.disposition).toBe('as_said');
    expect(stored.carrierKind).toBeNull();
  });

  it('holds for a filing with no quote: it makes no sentence claim to fail', () => {
    const decision = chooseDisposition(
      input({ quote: null, blockText: null, blockIndex: null, sentenceId: null, sentenceIndex: null }),
    );
    expect(decision.disposition).toBe('as_said');
    // No sentence and no place: the reading's one line still stands, with no anchor to invent.
    expect(chainLine(decision)).toBe(READING_LINES.as_said);
  });
});

describe('the proposal as it arrives — untrusted JSON from the decision line', () => {
  it('drops a word this build does not know, and keeps the numbers it understands', () => {
    const parsed = parseDispositionProposal({
      disposition: 'wide',
      carrierKind: 'document',
      quoteKept: '  срок тридцать дней  ',
      factsChanged: 2,
      lock: 'право',
    });
    expect(parsed).toMatchObject({
      // «wide» is not a disposition and «право» is not a lock id: both are dropped, not guessed.
      disposition: null,
      lock: null,
      carrierKind: 'document',
      quoteKept: 'срок тридцать дней',
      factsChanged: 2,
    });
  });

  it('answers null for anything that is not an object, and counts no facts it cannot count', () => {
    expect(parseDispositionProposal(null)).toBeNull();
    expect(parseDispositionProposal('through_paper')).toBeNull();
    expect(parseDispositionProposal({ factsChanged: 'many', carrierKind: 42 })).toMatchObject({
      factsChanged: 0,
      carrierKind: null,
    });
  });
});
