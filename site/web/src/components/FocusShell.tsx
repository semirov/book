import type { ReactNode, RefObject } from 'react';

/**
 * The dialog frame shared by the loading, the not-found and the settled states of the прицел
 * (§11.9).
 *
 * BOOK-DOC-43 §7 (BOOK-66) — `busy` puts `aria-busy="true"` on the surface's own `.focus`
 * container for the **whole** request; it is never set to «false», only removed (the prop is
 * absent once the change or the failure has landed).
 */
export function FocusShell({
  dialog,
  onClose,
  busy = false,
  children,
}: {
  dialog: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  /** The change is still being read: the surface is busy until it settles, data or failure. */
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="focus"
      role="dialog"
      aria-modal="true"
      aria-label="прицел"
      aria-busy={busy ? 'true' : undefined}
      ref={dialog}
      tabIndex={-1}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="focus-panel">{children}</div>
    </div>
  );
}
