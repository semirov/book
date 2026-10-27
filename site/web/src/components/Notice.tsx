import { chapterLabel } from '@book/shared';

/**
 * Талон (DESIGN §7.20): one quiet ticket when something happened to a chapter the reader
 * is **not** looking at. It never counts, never pulses, and disappears once the chapter is
 * reached. A change to the first sheet says «название изменилось» and scrolls up.
 */
export type Notice =
  | { kind: 'new'; n: number }
  | { kind: 'revised'; n: number }
  | { kind: 'front' };

export function NoticeTicket({
  notice,
  onGo,
  onDismiss,
}: {
  notice: Notice | null;
  onGo: (notice: Notice) => void;
  onDismiss: () => void;
}) {
  if (notice === null) return null;
  const label =
    notice.kind === 'new'
      ? `новая глава ${notice.n} ↓`
      : notice.kind === 'revised'
        ? `глава ${chapterLabel(notice.n)} поправлена ↓`
        : 'название изменилось ↑';

  return (
    <div className="ticket" role="status">
      <button className="ticket-go" type="button" onClick={() => onGo(notice)}>
        {label}
      </button>
      <button className="ticket-x" type="button" aria-label="скрыть" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
