import type { ReactNode, RefObject } from 'react';

/** The dialog frame shared by the loading and the not-found states of the прицел (§11.9). */
export function FocusShell({
  dialog,
  onClose,
  children,
}: {
  dialog: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="focus"
      role="dialog"
      aria-modal="true"
      aria-label="прицел"
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
