import type { AuthorsDto } from '@book/shared';
import { useCallback, useEffect, useState } from 'react';

import { getAuthors } from '../api.ts';
import { Authors } from './Authors.tsx';

/**
 * The end matter's data, loaded on its own (§6C.5).
 *
 * The shares are a *measurement*, not a live fact: they arrive from `/api/authors`, not from
 * the socket, and a failed request must not take the page down — the author and the
 * copyright are already known from the imprint, and only the numbers wait. Opening the
 * chronicle re-measures, because that is the moment a reader asks «как менялись доли».
 */
export function EndMatter({
  imprint,
  lastRevisionAt,
  onOpenChronicle,
}: {
  imprint: { author: string; copyright: string };
  lastRevisionAt: string | null;
  onOpenChronicle: () => void;
}) {
  const [authors, setAuthors] = useState<AuthorsDto | null>(null);

  const load = useCallback(async () => {
    try {
      setAuthors(await getAuthors());
    } catch {
      /* the end matter keeps the author and the copyright; the shares stay «—» */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Authors
      authors={authors}
      imprint={imprint}
      lastRevisionAt={lastRevisionAt}
      onOpenChronicle={() => {
        void load();
        onOpenChronicle();
      }}
    />
  );
}
