import type { ReactNode, RefObject } from 'react';
import { useEffect } from 'react';

import { attachOutsideClose } from '../lib/outsideClose.ts';

/**
 * The dialog frame shared by the loading, the not-found and the settled states of the прицел
 * (§11.9).
 *
 * BOOK-DOC-43 §7 (BOOK-66) — `busy` puts `aria-busy="true"` on the surface's own `.focus`
 * container for the **whole** request; it is never set to «false», only removed (the prop is
 * absent once the change or the failure has landed).
 *
 * BOOK-111 (owner, 2026-10-27) — the backdrop closes the sheet on a fine pointer only. On a
 * touch surface a tap outside the sheet changes nothing: «выйти», `Escape` from a hardware
 * keyboard, or the sheet's own action, so a graze cannot throw the change away.
 */
export function FocusShell({
  dialog,
  onClose,
  busy = false,
  label = 'прицел',
  onWheel,
  onTouchMove,
  children,
}: {
  dialog: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  /** The change is still being read: the surface is busy until it settles, data or failure. */
  busy?: boolean;
  /** The dialog's accessible name: one word for the waits, the change's number when settled. */
  label?: string;
  /** The sheet stops following the live chapter when the reader handles it — wheel or gesture. */
  onWheel?: () => void;
  onTouchMove?: () => void;
  children: ReactNode;
}) {
  // The sheet itself is inside; the backdrop is the frame around `.focus-panel`. A press that
  // began outside the panel is a backdrop click — read at event time, so a rotated tablet is
  // never answered from the stale answer of the mount that opened it.
  useEffect(() => {
    const panel = (): HTMLElement | null => dialog.current?.querySelector<HTMLElement>('.focus-panel') ?? null;
    return attachOutsideClose({
      isInside: (target) => panel()?.contains(target) === true,
      onOutside: onClose,
    });
  }, [dialog, onClose]);

  return (
    <div
      className="focus"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      aria-busy={busy ? 'true' : undefined}
      ref={dialog}
      tabIndex={-1}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
    >
      <div className="focus-panel">{children}</div>
    </div>
  );
}
