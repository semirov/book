import type { ChangeDto } from '@book/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getChange } from './api.ts';

/**
 * The change card's one call (§11.7) and its `Esc` (§DESIGN 7.14). The hook keeps the
 * "which card is open" ref so a `change:decided` frame can refresh the open card without
 * making the socket handler depend on React state.
 */
export type ChangeCardMode = {
  change: ChangeDto | null;
  open: (changeId: string) => void;
  close: () => void;
  /** Refresh only if this change is the one on screen. */
  refresh: (changeId: string) => void;
};

export function useChangeCard(): ChangeCardMode {
  const [change, setChange] = useState<ChangeDto | null>(null);
  const openId = useRef<string | null>(null);

  const open = useCallback((changeId: string) => {
    openId.current = changeId;
    void getChange(changeId)
      .then((loaded) => {
        if (openId.current === changeId) setChange(loaded);
      })
      .catch(() => {
        if (openId.current === changeId) setChange(null);
      });
  }, []);

  const close = useCallback(() => {
    openId.current = null;
    setChange(null);
  }, []);

  const refresh = useCallback(
    (changeId: string) => {
      if (openId.current === changeId) open(changeId);
    },
    [open],
  );

  useEffect(() => {
    if (change === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [change, close]);

  return { change, open, close, refresh };
}
