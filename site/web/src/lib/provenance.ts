import { formatDate, formatTime, plural } from './format.ts';

/**
 * BOOK-128 (designer, 2026-10-28, comment #3815) — «откуда это слово» is **marginalia**.
 *
 * A word's provenance is not a dialog: at ≥1024 it is a note beside the line the word stands
 * on, at ≤1023 it is the body of the strip that opened it. The panel's box, its scroll, its
 * uppercase table, its CTA and its own ✕ are gone with the panel. What is left is what a
 * margin can carry: **three facts and, for one hand only, one sentence.**
 *
 * The hand is the book's, not the web's: a pass wrote the prose (`печатник` — never «автор»,
 * which is false on a book a shift wrote), the frame holds the canon sentence (`рамка книги`),
 * page 2 is the basis (`основание книги`), a reader lent their name, and a version the log
 * cannot assign is `правка вне процесса`. When a reader's filing stands on the word, the hand
 * names the record the version came from.
 *
 * Two honesty rules are encoded here, not in a comment:
 *   - a **public** share can only print the numbers the server publishes for other readers;
 *     `survivedRevisions` lives on the `own` variant alone, so no path can print another
 *     reader's curve;
 *   - `следа нет` (the log holds no reader trace) and `след не измерен` (a reader wrote it and
 *     the curve is not ours to print) are different facts and never swap.
 */

export type TraceShare =
  | { kind: 'own'; share: number; survivedRevisions: number }
  | { kind: 'public'; share: number; edits: number }
  | { kind: 'none' }
  /** The log attributes this paragraph to a reader, but has no word-level share for it. */
  | { kind: 'unknown' };

/**
 * The doc names three variants; `reader` is the fourth shape the log actually produces — a
 * paragraph a reader wrote, with no word-level share to print. It says «след не измерен»,
 * never «следа нет» and never a borrowed number.
 */
export type ProvenanceVariant = 'machine' | 'frozen' | 'reader' | 'unattributed';

/** THE hand of a pass-written book: one word, everywhere a word is attributed. */
export const PASS_HAND = 'печатник';
export const FRAME_HAND = 'рамка книги';
export const BASIS_HAND = 'основание книги';
export const UNATTRIBUTED_HAND = 'правка вне процесса';

/**
 * The one sentence the layer may print, and only under `печатник`: a reader cannot know what
 * a shift is. It never repeats a fact above it, never says what will happen (the strip says
 * that before typing) and never speaks for the machine.
 */
export const PASS_GLOSS = 'печатник — смена, которая пишет книгу; рамку держит автор.';

/** A filing standing on the word: its own numeral, its state word, and the place it stands on. */
export type WordFiling = {
  /** The record's own numeral (`№A7K`); `lib/filings.ts` forbids an invented ordinal. */
  number: string;
  /**
   * The number of the change this filing's latest attempt became (`12`), read from the page's
   * window of changes (`filingAttempt`). The schema has **no filing sequence**: the number the
   * owner's spec prints (`правка · №12`) is the *change* the filing turned into, so a filing
   * that never became one has no number at all and `null` says exactly that.
   */
  seq: number | null;
  /** The state word from `lib/marginalia.ts` («ждёт» / «рассмотрено»). */
  state: string;
  /** The fragment the door opens — a real href, so a modified click keeps the browser's act. */
  href: string;
};

/**
 * The numeral a filing prints: its change's number (`№12`) when the window carries the attempt,
 * the record's own suffix (`№A7K`) when it does not — never a padded `012`, which the owner
 * reads as a book ordinal the row no longer claims.
 */
export function filingNumeral(filing: WordFiling): string {
  return filing.seq === null ? filing.number : `№${filing.seq}`;
}

/** What the margin prints for one word: three facts, one sentence, one door. */
export type WordFacts = {
  /** Line 1 — the hand, in the book's vocabulary. */
  hand: string;
  /** Line 2 — «с 28.10.2026, 12:08», or «вне правок» for the frame and the basis. */
  when: string;
  /** Line 3 — the trace, or the filing standing on the word. */
  trace: string;
  /** The gloss; `null` for every hand but `печатник`. */
  gloss: string | null;
  /** The filing the trace line opens, when one stands on this word. */
  filing: WordFiling | null;
};

export type WordInput = {
  variant: ProvenanceVariant;
  /** The last version's actor label — the reader's name when `variant` is `reader`. */
  actor: string | null;
  /** Which frozen surface the word sits on; absent for a writable paragraph. */
  frozenOf?: 'frame' | 'basis';
  /** The moment of the block's last version; `null` when the log has none. */
  at: string | null;
  share: TraceShare;
  filing: WordFiling | null;
};

/**
 * BOOK-33 — which trace the `след` line may print for a word.
 *
 * A reader's own paragraph shows their own line (`пережила N ревизий`), because the reader
 * owns that curve. Somebody else's paragraph shows nothing measured — never
 * `survivedRevisions`, which is served to its owner alone. A paragraph with no reader
 * attribution has no trace at all, and a reader word we cannot name says so.
 */
export function shareFor(input: {
  actor: { kind: string; label: string } | null;
  viewerName: string | null;
  own: { share: number; survivedRevisions: number } | null;
  publicShares: ReadonlyArray<{ label: string; share: number; edits: number }>;
}): TraceShare {
  const { actor, viewerName, own, publicShares } = input;
  if (actor === null || actor.kind !== 'reader') return { kind: 'none' };
  if (own !== null && viewerName !== null && actor.label === viewerName) {
    return { kind: 'own', share: own.share, survivedRevisions: own.survivedRevisions };
  }
  const foreign = publicShares.find((row) => row.label === actor.label);
  if (foreign !== undefined) return { kind: 'public', share: foreign.share, edits: foreign.edits };
  return { kind: 'unknown' };
}

/**
 * The trace line, in three shapes and no fourth: the viewer's own survival curve, the fact
 * that somebody else's curve is not ours to print, and the fact that there is none.
 */
export function traceLine(share: TraceShare): string {
  switch (share.kind) {
    case 'own':
      return `пережила ${share.survivedRevisions} ${plural(share.survivedRevisions, 'ревизию', 'ревизии', 'ревизий')}`;
    case 'public':
    case 'unknown':
      return 'след не измерен';
    default:
      return 'следа нет';
  }
}

/** `2026-10-21T12:04:11Z` → «28.10.2026, 12:08» (Moscow, the site's one clock). */
function moment(iso: string | null): string {
  if (iso === null) return 'вне правок';
  const date = formatDate(iso);
  const time = formatTime(iso);
  if (date === '—' || time === '—') return 'вне правок';
  return `с ${date}, ${time}`;
}

/**
 * The variant both layers read from one chain: one rule for the word and the phrase beside it,
 * so they can never disagree about who wrote the paragraph.
 */
export function variantOf(input: { frozen: boolean; actorKind: string | null | undefined }): ProvenanceVariant {
  if (input.frozen) return 'frozen';
  if (input.actorKind === 'reader') return 'reader';
  if (input.actorKind === undefined || input.actorKind === 'author' || input.actorKind === 'writer') return 'machine';
  return 'unattributed';
}

/** The hand a word's line 1 prints. Never a machine noun and never «автор». */
function handOf(input: WordInput): string {
  if (input.filing !== null) return `правка · ${filingNumeral(input.filing)}`;
  if (input.variant === 'frozen') return input.frozenOf === 'basis' ? BASIS_HAND : FRAME_HAND;
  if (input.variant === 'unattributed') return UNATTRIBUTED_HAND;
  if (input.variant === 'reader') return input.actor ?? PASS_HAND;
  return PASS_HAND;
}

/**
 * The word's three facts. The block is the answer, so a caller may only render it once the
 * log answered — a provenance printed from a default is a claim nobody made.
 */
export function wordFacts(input: WordInput): WordFacts {
  const hand = handOf(input);
  const frozen = input.variant === 'frozen';
  const filing = input.filing;
  return {
    hand,
    when: frozen ? 'вне правок' : moment(input.at),
    trace: filing === null ? (frozen ? 'следа нет' : traceLine(input.share)) : `${filingNumeral(filing)} · ${filing.state}`,
    gloss: hand === PASS_HAND ? PASS_GLOSS : null,
    filing,
  };
}
