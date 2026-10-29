import type { MouseEvent } from 'react';

/**
 * BOOK-221 — the one way back, at the top of every separate screen.
 *
 * The owner opened «ваш след» and asked where the button back was: every screen that is not the
 * book's front carries one exit, before its content, and it is the first stop in tab order. It
 * is a **real link** with a real `href` — the browser navigates and the back button returns — so
 * `onFollow` may only augment it. It never calls `preventDefault` and never sets the hash itself:
 * a page that needs to wait for its target (the trail waits for `#toc`, bounded at 20 frames)
 * lands the browser's own navigation, and a click with no handler is still a working link.
 *
 * One line, mono 12, lowercase, `--ink-3`, no underline: the sheet owns that (`chrome.css`).
 * On the static documents `href` is `/#toc`, because the book is another document.
 */
export function ScreenExit({ href = '#toc', onFollow }: { href?: string; onFollow?: () => void }) {
  /**
   * Only a plain left click is augmented: a new tab, a modified click or a middle click is the
   * browser's own business, and landing `#toc` on a tab that is not navigating would scroll a
   * page the reader did not ask to leave.
   */
  const follow =
    onFollow === undefined
      ? undefined
      : (event: MouseEvent<HTMLAnchorElement>): void => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
            return;
          }
          onFollow();
        };

  return (
    <p className="screen-exit">
      <a href={href} {...(follow === undefined ? {} : { onClick: follow })}>
        к оглавлению
      </a>
    </p>
  );
}
