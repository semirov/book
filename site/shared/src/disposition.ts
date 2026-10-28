/**
 * The disposition of a filing — how a reader's text was read instead of being thrown away
 * (BOOK-DOC-78, BOOK-174 comment #3888 §5–§6).
 *
 * A filing has four answers tried in order — `as_said` → `through_paper` →
 * `refused_in_world` → `inadmissible` — and a fifth state for the case where the ladder ran
 * out: `escalated`, the author's decision. Nothing here refuses by exhaustion: `inadmissible`
 * is reachable only through one of the four locks, and everything else is escalated.
 *
 * This file is the **one source** of the words a reader sees: the closed reason clauses, the
 * closed carrier labels, the lock lines and the lock alternatives. They are table entries and
 * never generated text — a generated reason leaks a verdict and can contradict yesterday's —
 * so no surface may spell its own version of them.
 *
 * The report is exactly three lines, ≤200 characters each, no codes, no findings, no gate:
 *
 *   прочитано как сказано
 *   потому что рядом нет предложения, которое от этого станет ложным
 *   где это в книге: глава 12 · абзац 4 · предложение 2
 *
 * Line 3 exists only when the sentence exists; `inadmissible` and `escalated` land nothing,
 * so their third line is the lock's alternative or the author's name. The anchor is **1-based
 * for the reader**: the stored `block_idx` and the sentence index are 0-based.
 */

/** The four answers, and the fifth state for a filing the ladder could not place. */
export type Disposition = 'as_said' | 'through_paper' | 'refused_in_world' | 'inadmissible' | 'escalated';

/** The six carriers a `through_paper` reading lands behind (BOOK-174 §2, closed list). */
export type CarrierKind =
  | 'document'
  | 'speech'
  | 'registry_discrepancy'
  | 'numbered_object'
  | 'unheeded_joke'
  | 'obligatory_joke';

/** The four locks, and no others: the only way to `inadmissible`. */
export type DispositionLock = 'rights' | 'harm' | 'frame' | 'finale';

export const DISPOSITIONS: readonly Disposition[] = [
  'as_said',
  'through_paper',
  'refused_in_world',
  'inadmissible',
  'escalated',
];

export const CARRIER_KINDS: readonly CarrierKind[] = [
  'document',
  'speech',
  'registry_discrepancy',
  'numbered_object',
  'unheeded_joke',
  'obligatory_joke',
];

export const DISPOSITION_LOCKS: readonly DispositionLock[] = ['rights', 'harm', 'frame', 'finale'];

/** The carrier as the third line names it: a reader's word, never the id. */
export const CARRIER_LABELS: Readonly<Record<CarrierKind, string>> = {
  document: 'документ',
  speech: 'чья-то речь',
  registry_discrepancy: 'расхождение в реестре',
  numbered_object: 'предмет с номером',
  unheeded_joke: 'шутка, которую никто не подхватил',
  obligatory_joke: 'анекдот по протоколу',
};

/** Line 2 of a landed reading — one closed clause per disposition, never generated. */
export const DISPOSITION_REASONS: Readonly<Record<Disposition, string>> = {
  as_said: 'потому что рядом нет предложения, которое от этого станет ложным',
  through_paper: 'потому что в сцене это некому сказать, а в регистратуре есть кому',
  refused_in_world: 'потому что в книге это уже установлено — мир может только ответить',
  inadmissible: 'потому что это отменяет исход',
  escalated: 'потому что эта правка меняет не слово, а исход',
};

/** Line 2 of a refusal: the lock's own why. */
export const LOCK_REASONS: Readonly<Record<DispositionLock, string>> = {
  rights: 'потому что это не ваш текст',
  harm: 'потому что это угроза человеку или чужие личные данные',
  frame: 'потому что у этой главы нет прозы, только фраза, и фраза не двигается',
  finale: 'потому что это отменяет исход',
};

/** Line 3 of a refusal: what works instead. Every refusal owes one. */
export const LOCK_ALTERNATIVES: Readonly<Record<DispositionLock, string>> = {
  rights:
    'перескажите своими в пяти словах — пересказ войдёт в бланк, в протокол или в чью-то реплику',
  harm: 'оставьте страх и уберите адрес — бумага умеет говорить «гражданин» и «объект»',
  frame: 'та же мысль — в любую написанную главу, или документом об этой фразе',
  finale:
    'те же слова — как заявление, которое отклоняют, или как вера героя, который ошибается',
};

/** Line 1 of each reading. `through_paper` has a second form — see `dispositionReport`. */
export const DISPOSITION_WORDS: Readonly<Record<Disposition, string>> = {
  as_said: 'прочитано как сказано',
  through_paper: 'прочитано через бумагу',
  refused_in_world: 'прочитано как отказ в мире',
  inadmissible: 'не принято',
  escalated: 'ждёт решения автора',
};

/** The one reading that names the plan it declined: both plans really existed. */
export const THROUGH_PAPER_NOT_AS_SAID = 'прочитано через бумагу, а не как сказано';

/** The question an escalated filing asks its author — also the row's public reason. */
export const ESCALATION_QUESTION = 'можно ли оформить это бумагой?';

/** The third line of an escalated filing: nothing landed, so no anchor is owed. */
export const ESCALATION_LINE = 'решает автор';

/** The bound every line of the report keeps (§5). */
export const REPORT_LINE_MAX_CHARS = 200;

export type DispositionReport = { line1: string; line2: string; line3: string };

/**
 * A stored chain: the five columns a filing keeps about how it was read. Old rows carry
 * `disposition: null` and have no report at all — the absence is the fact.
 */
export type DispositionChain = {
  disposition: Disposition;
  lock: DispositionLock | null;
  carrierKind: CarrierKind | null;
  /** The verbatim fragment behind a document, or the refusing stamp of an in-world refusal. */
  quoteKept: string | null;
  /** `b<blockIdx>.s<sentenceIdx>`, both 0-based as stored; null when nothing resolved. */
  sentenceId: string | null;
};

/** A closed word from storage, or null: a value this build does not know is dropped. */
function oneOf<T extends string>(value: string | null | undefined, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export function normalizeDisposition(value: string | null | undefined): Disposition | null {
  return oneOf(value, DISPOSITIONS);
}

export function normalizeCarrierKind(value: string | null | undefined): CarrierKind | null {
  return oneOf(value, CARRIER_KINDS);
}

export function normalizeDispositionLock(value: string | null | undefined): DispositionLock | null {
  return oneOf(value, DISPOSITION_LOCKS);
}

/** `b3.s2` — the stored anchor of a landed reading (0-based, never printed). */
export function formatSentenceId(blockIndex: number, sentenceIndex: number): string {
  return `b${String(blockIndex)}.s${String(sentenceIndex)}`;
}

const SENTENCE_ID = /^b(\d+)\.s(\d+)$/u;

/** The two 0-based numbers of a stored `b<block>.s<sentence>`, or null for anything else. */
export function parseSentenceId(sentenceId: string | null): { blockIndex: number; sentenceIndex: number } | null {
  if (sentenceId === null) return null;
  const match = SENTENCE_ID.exec(sentenceId);
  if (match === null) return null;
  return { blockIndex: Number.parseInt(match[1] ?? '', 10), sentenceIndex: Number.parseInt(match[2] ?? '', 10) };
}

/**
 * `где это в книге: глава 12 · абзац 4 · предложение 2` — the anchor in the reader's numbering.
 * A filing that landed without a located sentence keeps its chapter: the place it concerns is
 * still true, and naming a sentence that was never found would not be.
 */
export function anchorLine(chapter: number, blockIndex: number | null, sentence: number | null): string {
  let line = `где это в книге: глава ${String(chapter)}`;
  if (blockIndex !== null) line += ` · абзац ${String(blockIndex + 1)}`;
  if (blockIndex !== null && sentence !== null) line += ` · предложение ${String(sentence + 1)}`;
  return line;
}

/**
 * The three lines of one reading, from the deciding fact alone.
 *
 * `sentenceResolved` is "the quote resolved to exactly one sentence", and it is the only thing
 * that turns the `through_paper` heading into its second form: naming the plan that was
 * declined is honest only when that plan really existed. It is derived from stored data (the
 * sentence id), never from a second flag.
 */
export function dispositionReport(input: {
  disposition: Disposition;
  lock?: DispositionLock | null;
  carrierKind?: CarrierKind | null;
  chapter: number;
  blockIndex?: number | null;
  sentence?: number | null;
  sentenceResolved: boolean;
  stamp?: string | null;
}): DispositionReport {
  return {
    line1: headingOf(input),
    line2: clauseOf(input.disposition, input.lock ?? null),
    line3: thirdLineOf(input),
  };
}

function headingOf(input: {
  disposition: Disposition;
  sentenceResolved: boolean;
}): string {
  if (input.disposition === 'through_paper' && input.sentenceResolved) return THROUGH_PAPER_NOT_AS_SAID;
  return DISPOSITION_WORDS[input.disposition];
}

/** The lock's own why when one spoke; the disposition's closed clause otherwise. */
function clauseOf(disposition: Disposition, lock: DispositionLock | null): string {
  if (disposition === 'inadmissible' && lock !== null) return LOCK_REASONS[lock];
  return DISPOSITION_REASONS[disposition];
}

function thirdLineOf(input: {
  disposition: Disposition;
  lock?: DispositionLock | null;
  carrierKind?: CarrierKind | null;
  chapter: number;
  blockIndex?: number | null;
  sentence?: number | null;
  stamp?: string | null;
}): string {
  if (input.disposition === 'escalated') return ESCALATION_LINE;
  if (input.disposition === 'inadmissible') {
    const lock = input.lock ?? null;
    return lock === null ? ESCALATION_LINE : `сработает иначе: ${LOCK_ALTERNATIVES[lock]}`;
  }
  const anchor = anchorLine(input.chapter, input.blockIndex ?? null, input.sentence ?? null);
  if (input.disposition === 'through_paper') {
    const carrier = input.carrierKind ?? null;
    return carrier === null ? anchor : `${anchor} — ${CARRIER_LABELS[carrier]}`;
  }
  if (input.disposition === 'refused_in_world') {
    const stamp = (input.stamp ?? '').trim();
    return stamp.length === 0 ? anchor : `${anchor} — «${stamp}»`;
  }
  return anchor;
}

/** The report of a **stored** chain: the row's own reading, whichever surface asks for it. */
export function chainReport(chain: DispositionChain, chapter: number): DispositionReport {
  const at = parseSentenceId(chain.sentenceId);
  return dispositionReport({
    disposition: chain.disposition,
    lock: chain.lock,
    carrierKind: chain.carrierKind,
    chapter,
    blockIndex: at === null ? null : at.blockIndex,
    sentence: at === null ? null : at.sentenceIndex,
    // The ambiguity form is derived: a resolved sentence is the as-said plan having existed.
    sentenceResolved: at !== null,
    stamp: chain.disposition === 'refused_in_world' ? chain.quoteKept : null,
  });
}
