/**
 * The pass record's session (BOOK-166): `#проход-<changeId>` or `#проход-<chapter>-<passId>`
 * is a mode of the page, so this hook owns the hash, the one read behind it and the view.
 *
 * IFACE — the record's fetch and lifecycle:
 *
 *   (a) states: `idle` (no record hash) · `loading` (a key, no view yet) · `ready` (a key and
 *       its `PassRecordView`, whose own phase is `live`, `ended` or `absent`).
 *   (b) on each: `idle` renders the book; `loading` renders the page's heading slot alone (the
 *       heading never moves when the body arrives); `ready` renders the heading and the body.
 *       The page, not this hook, owns the one `scrollTo` after the body lands.
 *   (c) bounds: one read per key — `getStages` (+ the chapter's title/blocks) for a bare pass,
 *       `getChange` + `getStages` + `getChapter` + the filing's own paragraph for a change.
 *       No polling, no timer, no refetch on a re-render; a hash change cancels the request in
 *       flight and starts exactly one for the new key.
 *   (d) ownership: the hook owns the request and the small session; it keeps no growing store.
 *       A cancelled answer cannot paint: the `cancelled` flag is checked before `setSession`.
 */

import type { ChangeDto, ChapterDto, PassStageEvent } from '@book/shared';
import { useEffect, useState } from 'react';

import { getChange, getChapter, getComment, getStages } from '../api.ts';
import {
  parsePassRecordHash,
  passRecordView,
  type PassRecordKey,
  type PassRecordView,
} from './passRecord.ts';

export type PassRecordSession =
  | { phase: 'idle'; hash: null; key: null; view: null }
  | { phase: 'loading'; hash: string; key: PassRecordKey; view: null }
  | { phase: 'ready'; hash: string; key: PassRecordKey; view: PassRecordView };

const IDLE: PassRecordSession = { phase: 'idle', hash: null, key: null, view: null };

function sessionOf(hash: string): PassRecordSession {
  const key = parsePassRecordHash(hash);
  return key === null ? IDLE : { phase: 'loading', hash, key, view: null };
}

/** A missing answer is not a failure here: the page says «пока не писалась» rather than a code. */
const noStages = (): PassStageEvent[] => [];

async function readChapter(n: number): Promise<ChapterDto | null> {
  try {
    return await getChapter(n);
  } catch {
    return null;
  }
}

async function readStages(n: number, options: { pass?: string; limit?: number }): Promise<PassStageEvent[]> {
  try {
    return await getStages(n, options);
  } catch {
    return noStages();
  }
}

/** The one read behind a key: the stages first, the chapter beside them, the filing for a change. */
async function load(key: PassRecordKey): Promise<PassRecordView> {
  const nowMs = Date.now();
  if (key.kind === 'pass') {
    const [stages, chapter] = await Promise.all([
      readStages(key.chapter, { pass: key.passId }),
      readChapter(key.chapter),
    ]);
    return passRecordView({ key, stages, change: null, chapter, anchorIndex: null, nowMs });
  }

  let change: ChangeDto | null = null;
  try {
    change = await getChange(key.changeId);
  } catch {
    change = null;
  }
  if (change === null) {
    return passRecordView({ key, stages: [], change: null, chapter: null, anchorIndex: null, nowMs });
  }

  const [stages, chapter, filing] = await Promise.all([
    readStages(change.chapter, { limit: 200 }),
    readChapter(change.chapter),
    change.source.commentId === null
      ? Promise.resolve(null)
      : getComment(change.source.commentId).catch(() => null),
  ]);
  return passRecordView({
    key,
    stages,
    change,
    chapter,
    anchorIndex: filing?.anchor.blockIndex ?? null,
    nowMs,
  });
}

export function usePassRecord(): PassRecordSession {
  const [session, setSession] = useState<PassRecordSession>(() =>
    typeof window === 'undefined' ? IDLE : sessionOf(window.location.hash),
  );

  useEffect(() => {
    const sync = (): void =>
      setSession((current) => {
        const hash = window.location.hash;
        // A repeated event for the same hash is not a new key: it must not drop the answer
        // the page already shows back into `loading`.
        if (current.hash === hash) return current;
        return sessionOf(hash);
      });
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const hash = session.hash;
  useEffect(() => {
    if (hash === null) return;
    const key = parsePassRecordHash(hash);
    if (key === null) return;
    let cancelled = false;
    void load(key).then((view) => {
      if (!cancelled) setSession({ phase: 'ready', hash, key, view });
    });
    return () => {
      cancelled = true;
    };
  }, [hash]);

  return session;
}
