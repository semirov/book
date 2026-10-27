import type { ChangeDto, ChangeImpactDto } from '@book/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getChange, getHistoryImpact } from './api.ts';
import { parseFocusHash } from './lib/focus.ts';

/**
 * The focus view's session (ARCHITECTURE §11.9): `#правка-<changeId>` is a mode of the
 * same page, so this hook owns only what the mode needs — the hash, the change, its impact
 * and the close. The scroll offset and the dialog belong to the component that mounts.
 */
export type FocusMode = {
  id: string | null;
  change: ChangeDto | null;
  impact: ChangeImpactDto | null;
  missing: boolean;
  close: () => void;
  /** A socket frame for this change: refetch the change so the panel does not go stale. */
  bump: (changeId: string) => void;
};

export function useFocusMode(onOpen: () => void): FocusMode {
  const [id, setId] = useState<string | null>(() => parseFocusHash(window.location.hash));
  const [change, setChange] = useState<ChangeDto | null>(null);
  const [impact, setImpact] = useState<ChangeImpactDto | null>(null);
  const [missing, setMissing] = useState(false);
  const [tick, setTick] = useState(0);
  const idRef = useRef<string | null>(id);

  useEffect(() => {
    idRef.current = id;
  }, [id]);

  const close = useCallback(() => {
    if (parseFocusHash(window.location.hash) !== null) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
    setId(null);
    setChange(null);
    setImpact(null);
    setMissing(false);
  }, []);

  useEffect(() => {
    const sync = (): void => {
      const next = parseFocusHash(window.location.hash);
      setId(next);
      if (next !== null) onOpen();
    };
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [onOpen]);

  useEffect(() => {
    setChange(null);
    setImpact(null);
    setMissing(false);
  }, [id]);

  useEffect(() => {
    if (id === null) return;
    let cancelled = false;
    void getChange(id)
      .then((loaded) => {
        if (cancelled) return;
        setChange(loaded);
        setMissing(loaded === null);
      })
      .catch(() => {
        if (cancelled) return;
        setChange(null);
        setMissing(true);
      });
    void getHistoryImpact(id)
      .then((loaded) => {
        if (!cancelled) setImpact(loaded);
      })
      .catch(() => {
        if (!cancelled) setImpact(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id, tick]);

  const bump = useCallback((changeId: string) => {
    if (idRef.current === changeId) setTick((current) => current + 1);
  }, []);

  return { id, change: change !== null && change.id === id ? change : null, impact, missing, close, bump };
}
