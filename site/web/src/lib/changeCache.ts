import type { ChangeDto } from '@book/shared';
import { useEffect, useState } from 'react';

import { getChange } from '../api.ts';

/**
 * The change DTO the record's `правка` section reads.
 *
 * A change is a fact about a sentence, and the record may show the same change more than once
 * (a closed section, a second deep link): the answer is kept for the session, like the
 * paragraph's chain. `null` is the server's own «this change does not exist» and is kept too —
 * asking again cannot change it. A failed read is **not** kept: a 5xx is not an answer, and the
 * section must be able to say «не прочиталась» instead of waiting forever.
 */
const answers = new Map<string, ChangeDto | null>();
const inflight = new Map<string, Promise<ChangeDto | null>>();

export type KnownChange = { known: false } | { known: true; change: ChangeDto | null };

export function knownChange(id: string): KnownChange {
  if (!answers.has(id)) return { known: false };
  return { known: true, change: answers.get(id) ?? null };
}

export function loadChange(id: string): Promise<ChangeDto | null> {
  const memo = knownChange(id);
  if (memo.known) return Promise.resolve(memo.change);
  const pending = inflight.get(id);
  if (pending !== undefined) return pending;
  const request = getChange(id)
    .then((change) => {
      answers.set(id, change);
      return change;
    })
    .finally(() => {
      inflight.delete(id);
    });
  inflight.set(id, request);
  return request;
}

export type ChangeRead = { change: ChangeDto | null; failed: boolean };

/**
 * One read, owned by the surface that prints the change. `enabled` is the section's state: a
 * closed `правка` costs nothing, and opening it is the request.
 */
export function useChangeRead(changeId: string | null, enabled = true): ChangeRead {
  const [read, setRead] = useState<ChangeRead>(() => {
    if (changeId === null) return { change: null, failed: false };
    const memo = knownChange(changeId);
    return { change: memo.known ? memo.change : null, failed: false };
  });

  useEffect(() => {
    if (changeId === null || !enabled) return;
    const memo = knownChange(changeId);
    if (memo.known) {
      setRead({ change: memo.change, failed: false });
      return;
    }
    // A second change in the same record: the previous answer is not this one's.
    setRead({ change: null, failed: false });
    let cancelled = false;
    void loadChange(changeId)
      .then((change) => {
        if (!cancelled) setRead({ change, failed: false });
      })
      .catch(() => {
        if (!cancelled) setRead({ change: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [changeId, enabled]);

  return changeId === null ? { change: null, failed: false } : read;
}

/** Tests only: the memo is per module lifetime, and a fresh case wants a fresh client. */
export function resetChangeCache(): void {
  answers.clear();
  inflight.clear();
}
