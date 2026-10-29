import { describe, expect, it } from 'vitest';

import {
  BASIS_HAND,
  FRAME_HAND,
  PASS_GLOSS,
  PASS_HAND,
  UNATTRIBUTED_HAND,
  shareFor,
  traceLine,
  variantOf,
  wordFacts,
  type TraceShare,
  type WordInput,
} from './provenance.ts';

/**
 * BOOK-128 comment #3815 — «откуда это слово» is three facts and one sentence.
 *
 * One case per hand the book can print, in the book's own words: `машина` for a pass (never
 * «автор» — false on a book a shift wrote), `рамка книги` and `основание книги` for the two
 * frozen surfaces, a reader's name for their own version, `правка вне процесса` for a version
 * the log cannot assign, and `правка · №…` when a reader's filing stands on the word.
 */

// BOOK-218 — the filing's own public number, printed bare: no `№`, no cut id.
const FILING = { number: '1', seq: null, state: 'ждёт', href: '#ch-8-b3' };
/** The same filing once its attempt is in the page's window: the change number is its number. */
const ATTEMPT = { ...FILING, seq: 12 };

function facts(overrides: Partial<WordInput> = {}): ReturnType<typeof wordFacts> {
  return wordFacts({
    variant: 'machine',
    actor: null,
    at: '2026-10-28T09:08:00Z',
    share: { kind: 'none' },
    filing: null,
    ...overrides,
  });
}

describe('the word’s hand — one row per thing the log can say', () => {
  it('a pass wrote it: «машина», the moment, no trace, and the one gloss', () => {
    const view = facts();
    expect(view.hand).toBe(PASS_HAND);
    expect(view.hand).toBe('машина');
    expect(view.when).toBe('с 28.10.2026, 12:08');
    expect(view.trace).toBe('следа нет');
    expect(view.gloss).toBe('машина внесла правку; рамку держит автор.');
    expect(view.filing).toBeNull();
  });

  it('the frozen frame of the canon sentence: «рамка книги», «вне правок», no gloss', () => {
    const view = facts({ variant: 'frozen', frozenOf: 'frame' });
    expect(view.hand).toBe(FRAME_HAND);
    expect(view.when).toBe('вне правок');
    expect(view.trace).toBe('следа нет');
    expect(view.gloss).toBeNull();
  });

  it('page 2 is the basis, not the frame: «основание книги»', () => {
    const view = facts({ variant: 'frozen', frozenOf: 'basis' });
    expect(view.hand).toBe(BASIS_HAND);
    expect(view.when).toBe('вне правок');
    expect(view.gloss).toBeNull();
  });

  it('a reader’s version carries their own name, and no gloss to explain them', () => {
    const view = facts({ variant: 'reader', actor: 'Аня', share: { kind: 'own', share: 0.004, survivedRevisions: 4 } });
    expect(view.hand).toBe('Аня');
    expect(view.trace).toBe('пережила 4 редакции');
    expect(view.gloss).toBeNull();
  });

  it('a version nobody claims says «правка вне процесса»', () => {
    const view = facts({ variant: 'unattributed', at: null });
    expect(view.hand).toBe(UNATTRIBUTED_HAND);
    expect(view.when).toBe('вне правок');
    expect(view.trace).toBe('следа нет');
    expect(view.gloss).toBeNull();
  });

  it('a filing standing on the word names the record and states where it stands', () => {
    // BOOK-218 — the filing has its own noun: «замечание 12»; a change is «правка 012».
    const view = facts({ variant: 'reader', actor: 'Аня', filing: FILING });
    expect(view.hand).toBe('замечание 1');
    expect(view.trace).toBe('замечание 1 · ждёт');
    expect(view.filing).toEqual(FILING);
    // A record that stands on the word is not the pass's word: the gloss is not printed.
    expect(view.gloss).toBeNull();
  });

  it('a filing that became a change prints that change’s number in the change’s own noun', () => {
    // BOOK-218 — the object named is the change: `правка 012` beside the word, `правка 012 · ждёт`
    // on its trace. A filing that never became one keeps its own noun: «замечание 1».
    const view = facts({ variant: 'reader', actor: 'Аня', filing: ATTEMPT });
    expect(view.hand).toBe('правка 012');
    expect(view.trace).toBe('правка 012 · ждёт');
    expect(facts({ filing: { ...ATTEMPT, state: 'рассмотрено' } }).trace).toBe('правка 012 · рассмотрено');
    // The same filing with no attempt in the window keeps the filing's own public number.
    expect(facts({ filing: FILING }).trace).toBe('замечание 1 · ждёт');
  });

  it('says no moment rather than inventing one when the date cannot be read', () => {
    expect(facts({ at: 'not-a-moment' }).when).toBe('вне правок');
  });

  it('falls back to the pass’s hand for a reader the log does not name', () => {
    expect(facts({ variant: 'reader', actor: null }).hand).toBe(PASS_HAND);
  });

  it('a decided filing says so in the same line', () => {
    expect(facts({ filing: { ...FILING, state: 'рассмотрено' } }).trace).toBe('замечание 1 · рассмотрено');
  });
});

describe('the trace — three statements that must never swap', () => {
  it('says the log holds no reader trace', () => {
    expect(traceLine({ kind: 'none' })).toBe('следа нет');
  });

  it('prints the viewer’s own curve, and only the viewer’s', () => {
    expect(traceLine({ kind: 'own', share: 0.004, survivedRevisions: 4 })).toBe('пережила 4 редакции');
    expect(traceLine({ kind: 'own', share: 0.004, survivedRevisions: 1 })).toBe('пережила 1 редакцию');
    expect(traceLine({ kind: 'own', share: 0.004, survivedRevisions: 5 })).toBe('пережила 5 редакций');
  });

  it('says a foreign curve is not measured for this reader, not that it is absent', () => {
    const share: TraceShare = { kind: 'public', share: 0.12, edits: 3 };
    expect(traceLine(share)).toBe('след не измерен');
    expect(JSON.stringify(share)).not.toContain('survived');
    expect(traceLine({ kind: 'unknown' })).toBe('след не измерен');
  });
});

describe('which share a word may print (BOOK-33)', () => {
  const own = { share: 0.004, survivedRevisions: 4 };

  it('gives the viewer their own line on their own word', () => {
    expect(
      shareFor({
        actor: { kind: 'reader', label: 'Филипп' },
        viewerName: 'Филипп',
        own,
        publicShares: [{ label: 'Филипп', share: 0.004, edits: 3 }],
      }),
    ).toEqual({ kind: 'own', share: 0.004, survivedRevisions: 4 });
  });

  it('gives another reader no numbers at all, never the survival curve', () => {
    const share = shareFor({
      actor: { kind: 'reader', label: 'Аня' },
      viewerName: 'Филипп',
      own,
      publicShares: [{ label: 'Аня', share: 0.011, edits: 3 }],
    });
    expect(share).toEqual({ kind: 'public', share: 0.011, edits: 3 });
    expect(JSON.stringify(share)).not.toContain('survived');
  });

  it('says a reader word is unmeasured when nobody can be named', () => {
    expect(shareFor({ actor: { kind: 'reader', label: 'Аня' }, viewerName: null, own: null, publicShares: [] })).toEqual({
      kind: 'unknown',
    });
  });

  it('has no trace for a word the pass wrote', () => {
    expect(shareFor({ actor: { kind: 'author', label: 'автор' }, viewerName: 'Филипп', own, publicShares: [] })).toEqual({
      kind: 'none',
    });
  });
});

describe('the variant both layers read from one chain', () => {
  it('frozen wins over everything — the frame is not a writer’s version', () => {
    expect(variantOf({ frozen: true, actorKind: 'reader' })).toBe('frozen');
  });

  it('names the reader, the pass, and the version nobody claims', () => {
    expect(variantOf({ frozen: false, actorKind: 'reader' })).toBe('reader');
    expect(variantOf({ frozen: false, actorKind: 'writer' })).toBe('machine');
    expect(variantOf({ frozen: false, actorKind: 'author' })).toBe('machine');
    expect(variantOf({ frozen: false, actorKind: undefined })).toBe('machine');
    expect(variantOf({ frozen: false, actorKind: 'system' })).toBe('unattributed');
  });
});

describe('no machine copy comes back', () => {
  it('no hand but «машина» may print the gloss', () => {
    const hands = [
      facts({ variant: 'frozen', frozenOf: 'frame' }),
      facts({ variant: 'frozen', frozenOf: 'basis' }),
      facts({ variant: 'reader', actor: 'Аня' }),
      facts({ variant: 'unattributed' }),
      facts({ filing: FILING }),
    ];
    for (const view of hands) {
      expect(view.gloss, view.hand).toBeNull();
      expect(JSON.stringify(view)).not.toContain('родословн');
      expect(JSON.stringify(view)).not.toContain('автор');
    }
    expect(PASS_GLOSS).toContain('рамку держит автор');
  });

  it('prints no id and no uppercase word in any fact', () => {
    for (const view of [facts(), facts({ variant: 'reader', actor: 'Аня' }), facts({ filing: FILING })]) {
      const text = [view.hand, view.when, view.trace, view.gloss ?? ''].join(' ');
      expect(text).not.toMatch(/[0-9a-f]{8}/u);
      expect(text).not.toBe(text.toUpperCase());
    }
  });
});
