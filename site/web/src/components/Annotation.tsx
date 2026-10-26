import type { FrontDto } from '@book/shared';

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
 */
export function Annotation({ front }: { front: FrontDto }) {
  if (front.about === null) return null;
  const paragraphs = annotationParagraphs(front.about);

  return (
    <section className="page annotation" id="about" aria-label="о чём эта книга">
      {paragraphs.map((paragraph, index) => (
        <p className="p" key={index}>
          {paragraph}
        </p>
      ))}
    </section>
  );
}
