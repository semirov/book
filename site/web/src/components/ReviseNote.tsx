import type { ReviseView } from '../lib/revise.ts';
import { REVISE_LABEL } from '../lib/revise.ts';

/**
 * BOOK-158 — the refusal's own block on every surface that owns the filing: the hint, the door,
 * and the sentence that says why the door is shut.
 *
 * One component for the three places the owner named (the premise row, the register's entry and
 * the card), so the words, the disabled state and the wording of «исправить» cannot drift
 * between them. The reason itself is not printed here: each surface already carries it in its
 * own state line, and a second copy beside the hint would read as two refusals.
 *
 * A limit the server names keeps the control **disabled** and explains it under it — the reader
 * sees the door they will get back, and when. A filing the server did not open for revision at
 * all (held, or a server that predates the field) gets no door and no claim.
 */
export function ReviseNote({
  view,
  onRevise,
  className,
}: {
  view: ReviseView;
  /** The act on the row: the button is the origin, so the strip can hand focus back to it. */
  onRevise: (origin: HTMLElement) => void;
  /** The surface's own modifier (`premise-revise`, `comment-revise`, `filing-revise`). */
  className: string;
}) {
  return (
    <div className={`revise ${className}`}>
      {view.hint === null ? null : <p className="revise-hint">{view.hint}</p>}
      {view.allowed ? (
        <button type="button" className="seam-inline-action" onClick={(event) => onRevise(event.currentTarget)}>
          {REVISE_LABEL}
        </button>
      ) : view.blocked === null ? null : (
        <>
          <button type="button" className="seam-inline-action" disabled>
            {REVISE_LABEL}
          </button>
          <p className="revise-why">{view.blocked}</p>
        </>
      )}
    </div>
  );
}
