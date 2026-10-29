import type { CommentDto } from '@book/shared';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';

import { isAlive, unshownFilings } from '../lib/filings.ts';
import type { ProseMarks } from '../lib/proseMarks.ts';
import type { Sentence } from '../lib/seam.ts';
import { citedClass, FilingMark } from './FilingMark.tsx';
import { MarginNote } from './MarginNote.tsx';

/**
 * BOOK-68 / BOOK-128 #3852 — the paragraph as slices of its own text, never re-assembled.
 *
 * `splitSentences` covers the prose, not every character: the whitespace between two sentences,
 * a closing quote that follows a space, the leading indent and the tail after the last
 * recognised sentence all used to be dropped. Here every character reaches the page — a raw gap
 * is a text node, a sentence is one span holding exactly its slice, and the tail is raw text.
 *
 * The touched range is one more cut **inside** its sentence: the mark is an inline span, so no
 * line box moves and the paragraph reads the same closed, open and closed again. The sentence's
 * edge objects (the filing numeral, the margin note) follow the text, as
 * they always have.
 */
export function SentenceRuns({
  text,
  sentences,
  marks,
  from = 0,
  to = Number.POSITIVE_INFINITY,
  anchoredStart,
  touched,
  recordHere,
  roving,
  frozen,
  controls,
  onToggle,
  onOpenFiling,
}: {
  text: string;
  sentences: readonly Sentence[];
  marks: ProseMarks['marks'];
  from?: number;
  to?: number;
  /** The sentence the shipped strip speaks about, or -1. */
  anchoredStart: number;
  /** The range wearing the mark, if any. */
  touched: { start: number; end: number } | null;
  /** The block is open on that range. */
  recordHere: boolean;
  /** The paragraph is reachable by keyboard: roving tabindex over its sentences. */
  roving: boolean;
  /** The frozen frame: the mark is always the quiet one. */
  frozen: boolean;
  controls: string;
  onToggle: (range: { start: number; end: number }) => void;
  /** The sentence's own range travels with the filing: the record opens **there**. */
  onOpenFiling: (comment: CommentDto, origin: HTMLElement, range: { start: number; end: number }) => void;
}): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = from;
  /** BOOK-218 — the filings this block has already given a mark and a note. */
  const shown = new Set<string>();
  sentences.forEach((sentence, index) => {
    if (sentence.start < from || sentence.end > to) return;
    // The gap the splitter did not claim — double spaces, a stray quote, an indent.
    if (sentence.start > cursor) nodes.push(text.slice(cursor, sentence.start));
    const filings = marks.get(sentence.start);
    // BOOK-218 — one filing, one mark: the block draws each filing once, however many runs its
    // quote is reached from. A stale group shows nothing at all, as it always has.
    const fresh =
      filings === undefined || filings.stale ? [] : unshownFilings(filings, shown);
    for (const comment of fresh) shown.add(comment.id);
    const cited = citedClass(filings);
    // BOOK-68: the seam's own sentence wears one extra class, whose whole effect is the cited
    // rule's underline — text decoration sets no box, so no line moves.
    const marked = [cited, sentence.start === anchoredStart ? 'is-anchored' : null]
      .filter((name): name is string => name !== null && name !== undefined)
      .join(' ');
    // ADR-044 — the sentence is the unit, so the mark **is** the sentence span: the same node
    // carries the decoration, and no inner box is created inside the paragraph.
    const isTouched = touched !== null && touched.start === sentence.start;
    /** The paragraph's one tab stop: its first sentence. Arrows reach the rest (roving). */
    const isFirst = index === 0;
    nodes.push(
      <span
        key={`${String(sentence.start)}-${String(index)}`}
        className={marked === '' ? undefined : marked}
        data-s={sentence.start}
        data-quote={sentence.text}
      >
        {/*
         * ADR-044 — the sentence is the door, and it is a **valid button**: the control wraps
         * the sentence's own text and nothing else. The filing numerals are its siblings, so a
         * numeral's Enter keeps opening its filing, and `aria-expanded` describes a real
         * disclosure. One tab stop per paragraph (the first sentence); ArrowLeft/Right walk the
         * sentences and Enter/Space open the focused one.
         */}
        <span
          className={roving ? 'sentence-door' : undefined}
          {...(isTouched
            ? { 'data-touch': '', 'data-mark': recordHere ? undefined : frozen ? 'frozen' : 'last' }
            : {})}
          {...(roving
            ? {
                role: 'button',
                tabIndex: isFirst ? 0 : -1,
                'aria-expanded': isTouched ? recordHere : false,
                'aria-controls': isTouched && recordHere ? controls : undefined,
                onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                    event.preventDefault();
                    const doors = [
                      ...(event.currentTarget.closest('.p')?.querySelectorAll<HTMLElement>('.sentence-door') ?? []),
                    ];
                    const at = doors.indexOf(event.currentTarget);
                    doors[at + (event.key === 'ArrowRight' ? 1 : -1)]?.focus();
                    return;
                  }
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  onToggle({ start: sentence.start, end: sentence.end });
                },
              }
            : {})}
        >
          {text.slice(sentence.start, sentence.end)}
        </span>
        {filings === undefined || filings.stale || fresh.length === 0 ? null : (
          <>
            <FilingMark
              filings={{ ...filings, all: fresh }}
              onOpen={(comment, origin) => onOpenFiling(comment, origin, { start: sentence.start, end: sentence.end })}
            />
            {fresh.filter(isAlive).map((comment) => (
              <MarginNote
                key={comment.id}
                comment={comment}
                onOpen={(item, origin) => onOpenFiling(item, origin, { start: sentence.start, end: sentence.end })}
              />
            ))}
          </>
        )}
      </span>,
    );
    cursor = sentence.end;
  });
  // The tail after the last sentence — a paragraph need not end with a full stop.
  if (cursor < to) nodes.push(text.slice(cursor, to));
  return nodes;
}
