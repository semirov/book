import type { ViewerDto } from '@book/shared';
import { useState } from 'react';

import { logoutSession } from '../api.ts';

/** The failure line's one sentence: the attempt did not take, and the reader may try again. */
export const LOGOUT_FAILED = 'выйти не вышло · попробуйте ещё раз';

/**
 * The way out of a signed-in session (BOOK-115), as a row of the colophon.
 *
 * The row is one sentence — «вы — Филипп · выйти» — with the name in the register's ink-3 and
 * the verb as a real button: the session cookie is cleared by a POST (§17: no state-changing
 * GET), and a full reload is how every surface re-reads the page as a guest. A signed-out
 * reader has no row at all, so the footer never offers «войти» — the composer and the thread
 * are where entering belongs.
 *
 * `reload` is the test seam: jsdom cannot navigate, and a route replacing would not re-read
 * the surfaces the way the reload does.
 */
export function LogoutRow({
  viewer,
  reload = (url: string): void => window.location.assign(url),
}: {
  viewer: ViewerDto;
  reload?: (url: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!viewer.signedIn) return null;

  const name = viewer.displayName === null ? '' : viewer.displayName.trim();
  const who = name.length === 0 ? 'вы вошли' : `вы — ${name}`;

  const out = (): void => {
    // One POST: a second click while the first is in flight would race the same cookie.
    if (busy) return;
    setBusy(true);
    // The next attempt starts clean; the old line must not outlive the retry.
    setFailed(false);
    void logoutSession()
      .then(() => reload('/'))
      .catch(() => {
        setBusy(false);
        setFailed(true);
      });
  };

  return (
    <>
      <div className="row">
        <span className="logout-row">
          {`${who} · `}
          <button type="button" className="logout" onClick={out} disabled={busy}>
            выйти
          </button>
        </span>
      </div>
      {failed ? (
        <div className="row">
          <span className="logout-error">{LOGOUT_FAILED}</span>
        </div>
      ) : null}
    </>
  );
}
