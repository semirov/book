import type { ReactElement } from 'react';

import { SKELETON_LINES, type SkeletonVariant } from '../lib/skeleton.ts';

/**
 * BOOK-DOC-43 §3 — the shape of a thing that is coming (BOOK-66).
 *
 * Every bar is an empty `<span>`: no text, no label, no `title`, no `tabindex`, nothing
 * interactive, and the whole form is `aria-hidden="true"` — a placeholder that names itself
 * would say the status twice. Widths and counts stay out of the markup's `style` attribute
 * by rule (the CSP guard): geometry is a class, a `data-w` index or a `data-lines` count.
 * Nothing here moves: this book's one motion is text being typed at 18 cps.
 */
export function Skeleton({ variant }: { variant: SkeletonVariant }): ReactElement {
  if (variant === 'chapter' || variant === 'sheet') return <Paragraphs variant={variant} />;
  return <Rows variant={variant} />;
}

/** The prose field: 3 / 3 / 2 lines for a chapter, 2 / 2 inside the lit sheet. */
function Paragraphs({ variant }: { variant: 'chapter' | 'sheet' }): ReactElement {
  const counts = SKELETON_LINES[variant];
  const total = counts.reduce((sum, count) => sum + count, 0);
  // The chapter walks all eight widths in order; the sheet reuses four of them, because its
  // own paragraphs are the same prose and its last line is ragged too.
  const order = variant === 'chapter' ? [1, 2, 3, 4, 5, 6, 7, 8] : [1, 3, 4, 6];
  let cursor = 0;

  return (
    <div className={`skel skel-${variant}`} data-lines={total} aria-hidden="true">
      {counts.map((count, index) => {
        const start = cursor;
        cursor += count;
        return (
          <p className="skel-p" key={index}>
            {Array.from({ length: count }, (_, line) => (
              <span className="skel-line" data-w={order[start + line] ?? 1} key={line} />
            ))}
          </p>
        );
      })}
    </div>
  );
}

/** The list surfaces: three rows each, in the grid the real row uses. */
function Rows({ variant }: { variant: 'register' | 'chronicle' | 'authors' | 'chain' }): ReactElement {
  const rows = SKELETON_LINES[variant].reduce((sum, count) => sum + count, 0);
  return (
    <div className={`skel skel-${variant}`} data-rows={rows} aria-hidden="true">
      {variant === 'chronicle' ? <span className="skel-line skel-day" /> : null}
      {Array.from({ length: rows }, (_, index) => (
        <Row variant={variant} key={index} />
      ))}
    </div>
  );
}

function Row({ variant }: { variant: 'register' | 'chronicle' | 'authors' | 'chain' }): ReactElement {
  if (variant === 'register') {
    // A meta line — numeral, label, date — and two body lines at 92 / 71 %.
    return (
      <div className="skel-row">
        <div className="skel-meta">
          <span className="skel-line skel-num" />
          <span className="skel-line skel-label" />
          <span className="skel-line skel-date" />
        </div>
        <span className="skel-line skel-body" />
        <span className="skel-line skel-body skel-body-short" />
      </div>
    );
  }
  if (variant === 'chronicle') {
    return (
      <div className="skel-row">
        <span className="skel-line skel-time" />
        <span className="skel-line skel-target" />
        <span className="skel-line skel-summary" />
      </div>
    );
  }
  if (variant === 'authors') {
    // The share column is the literal «—»: the honest unknown already on the real row, so
    // the placeholder never invents a number it does not hold.
    return (
      <div className="skel-row">
        <span className="skel-line skel-name" />
        <span className="skel-line skel-role" />
        <span className="skel-share">—</span>
      </div>
    );
  }
  return (
    <div className="skel-row">
      <span className="skel-line skel-version" />
      <span className="skel-line skel-copy" />
      <span className="skel-line skel-actor" />
    </div>
  );
}
