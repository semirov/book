import type { FrontDto } from '@book/shared';

import { ABOUT_PARAGRAPHS } from '../lib/frontSequence.ts';

/**
 * A newline inside a paragraph is a line break of the manuscript file, not of the text:
 * the file is hard-wrapped at ~100 characters, and a justified column must reflow it.
 * Blank lines still split paragraphs, and every character the author typed stays as it is
 * (dashes and punctuation are untouched — only the whitespace around a newline becomes
 * one space). The served text keeps its wrapping: this is a rendering concern.
 */
function softWrap(paragraph: string): string {
  return paragraph.replace(/[^\S\n]*\n[^\S\n]*/gu, ' ');
}

/** Page 2's paragraphs: split on blank lines, then joined across hard wraps. */
function annotationParagraphs(about: string): string[] {
  return about
    .split(/\n\s*\n/u)
    .map((paragraph) => softWrap(paragraph.trim()))
    .filter((paragraph) => paragraph.length > 0);
}

/**
 * Page 2 (BOOK-DOC-5 §3, ARCHITECTURE §6C.2, §11.8): the live annotation, set as the
 * opening of the prose. It is the book's first text, not a blurb about the book — no
 * visible label, no box, no animation; the accessible name lives in the `aria-label`.
 * A malformed first sheet renders nothing here — the site never fabricates a blurb.
 *
 * `seq` tags page 2's own nine paragraphs for the first load (BOOK-DOC-49 §2): the sequence
 * covers the nine the front matter carries, and a tenth paragraph — should the owner ever add
 * one — is below the fold and simply arrives set, never waiting for a turn that has no delay.
 *
 * BOOK-DOC-34 §2.6 asks for the frozen word provenance on this page too («основание»). It is
 * **not** wired yet, and the gap is stated rather than faked: page 2 has no sentence anchors,
 * no seam and no panel, so a tap here does nothing. The frame chapters (ch01/ch67) do carry
 * the frozen variant; page 2 needs the same treatment when the annotation becomes a sentence
 * surface (the panel already knows the `basis` wording).
 */
export function Annotation({ front, seq = false }: { front: FrontDto; seq?: boolean }) {
  if (front.about === null) return null;
  const paragraphs = annotationParagraphs(front.about);

  return (
    <section className="page annotation" id="about" aria-label="о чём эта книга">
      {paragraphs.map((paragraph, index) => (
        <p
          className="p"
          key={index}
          data-seq={seq && index < ABOUT_PARAGRAPHS ? `about-${index + 1}` : undefined}
        >
          {paragraph}
        </p>
      ))}
    </section>
  );
}
