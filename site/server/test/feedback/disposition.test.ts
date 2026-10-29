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
  CARRIER_LABELS,
  DISPOSITION_REASONS,
  LOCK_ALTERNATIVES,
  LOCK_REASONS,
  REPORT_LINE_MAX_CHARS,
  STAMP_MAX_CHARS,
  chainReport,
  dispositionReport,
  DISPOSITION_WORDS,
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
/** The place a decision is rendered against: block 3, sentence 1 → «абзац 4 · предложение 2». */
const ANCHOR = { chapter: 12, blockIndex: 3, sentenceIndex: 1 };

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
      reason: DISPOSITION_REASONS.as_said,
      sentenceId: SENTENCE_ID,
      blockIndex: 3,
      sentenceIndex: 1,
      alternate: false,
    });
    expect(chainReport(decision, ANCHOR, true)).toEqual({
      line1: 'прочитано как сказано',
      line2: DISPOSITION_REASONS.as_said,
      line3: 'где это в книге: глава 12 · абзац 4 · предложение 2',
    });
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
    expect(chainReport(decision, ANCHOR, true).line3).toBe(
      'где это в книге: глава 12 · абзац 4 · предложение 2 — документ',
    );
  });

  it('refused_in_world: the four facts and the caps let the world answer, the stamp is line 3', () => {
    const decision = chooseDisposition(inWorld());
    expect(decision).toMatchObject({
      disposition: 'refused_in_world',
      quoteKept: STAMP,
      sentenceId: SENTENCE_ID,
      reason: DISPOSITION_REASONS.refused_in_world,
    });
    expect(chainReport(decision, ANCHOR, true)).toEqual({
      line1: 'прочитано как отказ в мире',
      line2: DISPOSITION_REASONS.refused_in_world,
      line3: `где это в книге: глава 12 · абзац 4 · предложение 2 — «${STAMP}»`,
    });
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
        reason: LOCK_REASONS[lock],
        // A lock carries its sentence, and nothing that would point at a place in the book.
        carrierKind: null,
        sentenceId: null,
        quoteKept: null,
        blockIndex: null,
        sentenceIndex: null,
      });
      expect(chainReport(decision, ANCHOR, true)).toEqual({
        line1: 'не принято',
        line2: LOCK_REASONS[lock],
        line3: `сработает иначе: ${LOCK_ALTERNATIVES[lock]}`,
      });
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
    expect(chainReport(decision, ANCHOR, false)).toEqual({
      line1: 'прочитано как сказано',
      line2: DISPOSITION_REASONS.as_said,
      line3: 'где это в книге: глава 12 · абзац 4 · предложение 2',
    });
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

describe('the 200-character bound of a line (BOOK-174 §5)', () => {
  it('refuses an overlong stamp: the refusal is not licensed and the reading goes one rung up', () => {
    const stamp = 'не соответствует форме '.repeat(14).trim(); // 300 characters
    expect(stamp.length).toBeGreaterThan(STAMP_MAX_CHARS);
    const decision = chooseDisposition(inWorld({ stamp }));
    expect(decision.disposition).not.toBe('refused_in_world');
    // No carrier to fall back on → the words stand as said, never a refusal with an unreadable line.
    expect(decision.disposition).toBe('as_said');
    expect(decision.quoteKept).toBeNull();
  });

  it('refuses to render a line past the bound, rather than trimming a decision', () => {
    expect(() =>
      dispositionReport({
        disposition: 'refused_in_world',
        chapter: 12,
        blockIndex: 3,
        sentence: 1,
        sentenceResolved: true,
        stamp: 'ф'.repeat(REPORT_LINE_MAX_CHARS),
      }),
    ).toThrow(/bound/u);
  });

  it('keeps a stored row readable: the formatter cuts an unlicensed stamp to the bound', () => {
    const report = chainReport(
      {
        disposition: 'refused_in_world',
        lock: null,
        carrierKind: null,
        quoteKept: 'ф'.repeat(300),
        sentenceId: SENTENCE_ID,
      },
      ANCHOR,
      true,
    );
    for (const line of Object.values(report)) expect(line.length).toBeLessThanOrEqual(REPORT_LINE_MAX_CHARS);
    expect(report.line3).toContain('…');
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

describe('the report’s two forms and its bounds', () => {
  it('names the declined plan only when the as_said rung really held', () => {
    const both = chooseDisposition(paper());
    expect(both.alternate).toBe(true);
    expect(chainReport(both, ANCHOR, true).line1).toBe('прочитано через бумагу, а не как сказано');

    // No sentence resolved: the said plan never existed.
    const unresolved = chooseDisposition(
      input({
        quote: TWO_SENTENCES,
        sentenceId: null,
        sentenceIndex: null,
        proposal: { disposition: 'through_paper', carrierKind: 'document', quoteKept: KEPT, factsChanged: 1 },
      }),
    );
    expect(unresolved.alternate).toBe(false);
    expect(chainReport(unresolved, { chapter: 12, blockIndex: 3, sentenceIndex: null }, false).line1).toBe(
      'прочитано через бумагу',
    );

    // The `as_said` rung is what decides, never the sentence alone: a carrier waives the
    // repeated-literal rule (a document may carry a standing number), so that wording really had
    // the said plan and the second form is honest.
    const withLiteral = chooseDisposition(
      input({
        blockText: 'Срок — 30 дней. Он вошёл.',
        quote: 'Срок — 30 дней.',
        body: 'Срок 30 дней и всё, что было сказано.',
        proposedText: null,
        proposal: {
          disposition: 'through_paper',
          carrierKind: 'document',
          quoteKept: 'Срок 30 дней и всё',
          factsChanged: 1,
        },
      }),
    );
    expect(withLiteral.disposition).toBe('through_paper');
    expect(withLiteral.alternate).toBe(true);

    // …while the same wording with no carrier fails `as_said` and has no paper to fall back on:
    // it lands at the floor, and no report claims a plan that never existed.
    const noCarrier = chooseDisposition(
      input({
        blockText: 'Срок — 30 дней. Он вошёл.',
        quote: 'Срок — 30 дней.',
        body: 'Срок 30 дней и всё, что было сказано.',
        proposedText: null,
      }),
    );
    expect(noCarrier.disposition).toBe('as_said');
    expect(noCarrier.alternate).toBe(false);
  });

  it('keeps every line of every report within 200 characters', () => {
    const decisions = [
      chooseDisposition(input()),
      chooseDisposition(paper()),
      chooseDisposition(inWorld()),
      chooseDisposition(input({ rightsVerdict: 'REFUSED' })),
      chooseDisposition(input({ quote: TWO_SENTENCES, proposal: { disposition: 'refused_in_world' } })),
    ];
    for (const decision of decisions) {
      for (const line of Object.values(chainReport(decision, ANCHOR, true))) {
        expect(line.length).toBeLessThanOrEqual(REPORT_LINE_MAX_CHARS);
        // No code, no gate name, no findings — the reader reads words.
        expect(line).not.toMatch(/[A-Z_]{4,}/u);
      }
    }
  });

  it('has one closed word per reading and a closed label per carrier', () => {
    // BOOK-206: four readings and no fifth — a filing is placed, never parked for a person.
    expect(Object.values(DISPOSITION_WORDS)).toEqual([
      'прочитано как сказано',
      'прочитано через бумагу',
      'прочитано как отказ в мире',
      'не принято',
    ]);
    expect(Object.values(CARRIER_LABELS)).toEqual([
      'документ',
      'чья-то речь',
      'расхождение в реестре',
      'предмет с номером',
      'шутка, которую никто не подхватил',
      'анекдот по протоколу',
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
    // Nothing landed on a sentence, so the report names the chapter and no place in it.
    expect(chainReport(decision, { chapter: 12, blockIndex: null, sentenceIndex: null }, false).line3).toBe(
      'где это в книге: глава 12',
    );
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
