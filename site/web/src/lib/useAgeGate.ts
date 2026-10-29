import { useCallback, useState } from 'react';

import { postAge } from '../api.ts';
import { readAgeAcknowledgement } from './age.ts';

/**
 * BOOK-225 — the page's one piece of age state.
 *
 * `acknowledgedAt` is the reader's own day, read from the device before the first request (so a
 * reload keeps a reader past the gate), and it flips only on a **confirmed** answer: `POST
 * /api/age` writes the cookie and answers the day it wrote, and a refusal returns `false` with
 * the state untouched. Nothing here guesses, and nothing claims before the server has spoken.
 *
 * It lives beside `lib/age.ts` rather than inside `App`, because `App` is the page's composition
 * and this is one fact with one rule — the same reason the copy lives in that module.
 */
export function useAgeGate(): { acknowledged: boolean; accept: () => Promise<boolean> } {
  const [acknowledgedAt, setAcknowledgedAt] = useState<string | null>(() => readAgeAcknowledgement());
  const accept = useCallback(async (): Promise<boolean> => {
    try {
      const { acknowledgedAt: day } = await postAge();
      setAcknowledgedAt(day);
      return true;
    } catch {
      return false;
    }
  }, []);
  return { acknowledged: acknowledgedAt !== null, accept };
}
