import { useEffect, useState } from 'react';

/**
 * BOOK-207 — «ваш след» is a mode of the same page, chosen by the hash `#след`.
 *
 * The record keeps its own door (`?change=`); the trail is the third hash mode after `#ch-N`
 * and `#toc`. The hash is decoded and matched exactly, so a pasted address and the foot's own
 * anchor open the same page, and any other hash is the book. The hook owns nothing but the
 * mode: `TrailPage` reads its own data, and `к оглавлению` (`#toc`) is the way back.
 */

export const TRAIL_HASH = '#след';

/** `#след` — decoded, exact; anything else is not the trail. */
export function isTrailHash(hash: string): boolean {
  try {
    return decodeURIComponent(hash) === TRAIL_HASH;
  } catch {
    return false;
  }
}

export function useTrail(): boolean {
  const [open, setOpen] = useState(
    () => typeof window !== 'undefined' && isTrailHash(window.location.hash),
  );
  useEffect(() => {
    const read = (): void => setOpen(isTrailHash(window.location.hash));
    window.addEventListener('hashchange', read);
    window.addEventListener('popstate', read);
    return () => {
      window.removeEventListener('hashchange', read);
      window.removeEventListener('popstate', read);
    };
  }, []);
  return open;
}
