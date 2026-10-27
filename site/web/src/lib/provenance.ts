import { formatShare, type ParagraphChainDto } from '@book/shared';

import { changeNumber } from './changeStatus.ts';
import { plural } from './format.ts';

/**
 * BOOK-DOC-34 §2.6 — the DNA panel: one word's provenance, said honestly.
 *
 * Three variants share one skeleton: a **machine** word (the majority — the author wrote it
 * and no reader touched the paragraph), a **frozen** word (the frame of ch01/ch67 and page 2)
 * and an **unattributed** word (a version the log cannot assign to anybody).
 *
 * The honesty rules are encoded in the types, not in a comment: a **public** share can only
 * carry the numbers the server publishes for other readers (`share`, `edits`); the viewer's
 * own `survivedRevisions` lives on the `own` variant alone, so no rendering path can print
 * another reader's curve. Word-level precision does not exist in the log, so the panel says
 * «слово в пределах абзаца» in the quiet tone instead of guessing a span.
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

export type ProvenanceInput = {
  word: string;
  chapter: number;
  variant: ProvenanceVariant;
  /** What the panel may say about the trace; the caller decides what it legitimately holds. */
  share: TraceShare;
  chain: ParagraphChainDto | null;
  /** The moment of the block's last version, for «когда». */
  at: string | null;
  /** The frozen variants say why: the book's frame, or the page 2 basis. */
  frozenOf?: 'frame' | 'basis';
};

export type ProvenanceRow = { label: string; value: string; quiet?: boolean };

export type ProvenanceView = {
  title: string;
  word: string;
  chapterLine: string;
  chain: Array<{ label: string; value: string }>;
  rows: ProvenanceRow[];
  copy: string | null;
  action: { kind: 'form' | 'rules'; label: string };
};

/**
 * BOOK-33 — which trace the `след` row may print for a word.
 *
 * A reader's own paragraph shows their own line (`пережила N ревизий`), because the reader
 * owns that curve. Somebody else's paragraph shows the public numbers the authors list
 * publishes — never `survivedRevisions`, which is served to its owner alone. A paragraph with
 * no reader attribution has no trace at all, and a reader word we cannot name says so.
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

/** «пережила 4 ревизии, сейчас 0,4 %» — the viewer's own trace, never anybody else's. */
export function shareLine(share: TraceShare): string {
  switch (share.kind) {
    case 'own':
      return `пережила ${share.survivedRevisions} ${plural(share.survivedRevisions, 'ревизию', 'ревизии', 'ревизий')}, сейчас ${formatShare(share.share)}`;
    case 'public':
      return `доля в книге ${formatShare(share.share)} · правок ${share.edits}`;
    case 'unknown':
      return 'след не измерен для этой строки';
    default:
      return 'читательского следа нет';
  }
}

/** «переписан 3 раза после неё» — public, per block, from the paragraph's own chain. */
export function rewriteLine(chain: ParagraphChainDto | null): string {
  const rewrites = chain === null ? 0 : chain.versions.filter((version) => version.op === 'revised').length;
  if (rewrites === 0) return 'написан целиком; читательских правок в нём не было';
  return `переписан ${rewrites} ${plural(rewrites, 'раз', 'раза', 'раз')} после неё`;
}

/** `2026-10-21T12:04:11Z` → «21.10.2026, 12:04»; the site prints Moscow time. */
function moment(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${day}.${month}.${date.getFullYear()}, ${time}`;
}

const MACHINE_COPY = 'у этого слова нет читательской родословной: его написал автор.';

export function provenanceView(input: ProvenanceInput): ProvenanceView {
  const last = input.chain?.versions.at(-1) ?? null;
  const actor = last?.actor?.label ?? (input.variant === 'unattributed' ? 'правка вне процесса' : 'автор');
  const where = input.variant === 'frozen' ? 'вне правок' : last === null ? 'в тексте' : `в тексте с ${moment(last.at)}`;

  const rows: ProvenanceRow[] = [
    { label: 'кто внёс', value: actor },
    { label: 'когда', value: moment(input.at ?? last?.at ?? null) },
    { label: 'след', value: input.variant === 'frozen' ? frozenTrace(input.frozenOf) : shareLine(input.share) },
    { label: 'абзац', value: rewriteLine(input.chain) },
  ];
  if (input.variant !== 'frozen') rows.push({ label: 'точность', value: 'слово в пределах абзаца', quiet: true });

  return {
    title: 'откуда это слово',
    word: input.word,
    chapterLine: `глава ${String(input.chapter).padStart(2, '0')}`,
    chain: [
      { label: 'кто', value: actor },
      // BOOK-59: the book speaks in numbers — «правка 014», never `chg_01J…`.
      { label: 'правка', value: last?.changeSeq == null ? 'вне правок' : `правка ${changeNumber(last.changeSeq)}` },
      { label: 'эта страница', value: where },
    ],
    rows,
    copy: input.variant === 'machine' ? MACHINE_COPY : null,
    action:
      input.variant === 'frozen'
        ? { kind: 'rules', label: 'что это значит →' }
        : { kind: 'form', label: 'вмешаться здесь' },
  };
}

/** The frozen variants: the frame says «закреплено», page 2 says «основание». */
function frozenTrace(frozenOf: ProvenanceInput['frozenOf']): string {
  return frozenOf === 'basis' ? 'основание; страница не редактируется' : 'закреплено; не меняется';
}

/** The word a tap on a frozen chapter may still explain: no form, only what it means. */
export function frozenActionHref(): string {
  return '/rules#рамка';
}
