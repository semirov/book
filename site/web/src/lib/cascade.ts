/**
 * The cascade ribbon and its escalation markers (ARCHITECTURE.md §11.7, DESIGN §7.2, §8.4).
 *
 * Pure geometry and a small reducer, so "a change walks two chapters in both directions"
 * can be asserted without a DOM. `state.cascade` is the authority after a reconnect; while
 * a socket is live, `change:processing` / `cascade:progress` / `change:decided` move the
 * ribbon. A queued change is never drawn here — it has no place yet (§11.7).
 */

import {
  TOTAL_CHAPTERS,
  type CascadeProgressPayload,
  type ChangeDecidedPayload,
  type ChangeProcessingPayload,
  type SeamBoundary,
  type StateSnapshot,
} from '@book/shared';

import { chapterPercent } from './spine.ts';

/** The ripple bound; the readout says «волна 2 / 3» (§6D.2). */
export const RIBBON_MAX_WAVE = 3;

export type RibbonSeam = { boundary: SeamBoundary; reason: string; resolved: boolean };

export type Ribbon = {
  changeId: string;
  cascadeId: string | null;
  /** Where the change landed. */
  chapter: number;
  wave: number;
  status: 'open' | 'closed' | 'escalated';
  outcome: string | null;
  touched: number[];
  rewritten: number[];
  /** The chapter of the step in flight; null when the ripple is between steps. */
  step: number | null;
  frontier: { down: number; up: number };
  seams: RibbonSeam[];
};

export type RibbonEvent = { type: string; data: unknown };

export function ribbonFromState(state: StateSnapshot): Ribbon | null {
  const cascade = state.cascade;
  if (cascade === null) return null;
  const step = cascade.stepChapter === 'front' ? null : cascade.stepChapter;
  const origin = cascade.origin ?? cascade.frontier.backward ?? cascade.frontier.forward ?? 1;
  return {
    changeId: cascade.changeId,
    cascadeId: cascade.id,
    chapter: origin,
    wave: cascade.wave,
    status: 'open',
    outcome: null,
    touched: [...cascade.touched].sort((left, right) => left - right),
    rewritten: [...(cascade.rewritten ?? [])].sort((left, right) => left - right),
    step,
    frontier: {
      down: cascade.frontier.backward ?? cascade.frontier.forward ?? 1,
      up: cascade.frontier.forward ?? cascade.frontier.backward ?? 1,
    },
    seams: (cascade.seams ?? []).map((seam) => ({ ...seam, resolved: false })),
  };
}

function mergeNumbers(left: number[], right: number[] | undefined): number[] {
  const merged = new Set<number>(left);
  for (const value of right ?? []) merged.add(value);
  return [...merged].sort((a, b) => a - b);
}

function mergeSeams(left: RibbonSeam[], right: Array<{ boundary: SeamBoundary; reason: string; resolved?: boolean }>): RibbonSeam[] {
  const merged = new Map<SeamBoundary, RibbonSeam>();
  for (const seam of left) merged.set(seam.boundary, seam);
  for (const seam of right) merged.set(seam.boundary, { boundary: seam.boundary, reason: seam.reason, resolved: seam.resolved === true });
  return [...merged.values()];
}

/**
 * Reconcile the narrative with a snapshot (§10.4: state wins). A ripple that is gone from
 * `state.cascade` is over even if its `change:decided` frame was dropped; a change that is
 * still processing but has not opened a ripple yet keeps its single tick.
 */
export function ribbonAfterSnapshot(held: Ribbon | null, state: StateSnapshot): Ribbon | null {
  const fromState = ribbonFromState(state);
  if (fromState !== null) return fromState;
  if (held === null) return null;
  if (held.status !== 'open') return null;
  return held.cascadeId === null ? held : null;
}

/**
 * Move the ribbon by one frame. `null` means "nothing to draw": a local change (no ripple)
 * and a decided change that never opened one both collapse to no ribbon.
 */
export function reduceRibbon(current: Ribbon | null, event: RibbonEvent): Ribbon | null {
  if (event.type === 'change:processing') {
    const payload = event.data as ChangeProcessingPayload;
    if (current !== null && current.changeId === payload.id) return { ...current, status: 'open' };
    return {
      changeId: payload.id,
      cascadeId: null,
      chapter: payload.chapter,
      wave: 0,
      status: 'open',
      outcome: null,
      touched: [payload.chapter],
      rewritten: [],
      step: null,
      frontier: { down: payload.chapter, up: payload.chapter },
      seams: [],
    };
  }

  if (event.type === 'cascade:progress') {
    const payload = event.data as CascadeProgressPayload;
    const base = current !== null && current.changeId === payload.changeId ? current : null;
    const step = typeof payload.chapter === 'number' ? payload.chapter : null;
    const touched = mergeNumbers(base?.touched ?? [payload.origin], payload.touched);
    return {
      changeId: payload.changeId,
      cascadeId: payload.cascadeId,
      chapter: base?.chapter ?? payload.origin,
      wave: payload.wave,
      status: payload.phase === 'escalated' ? 'escalated' : 'open',
      outcome: payload.phase === 'absorbed' ? 'absorbed' : null,
      touched,
      rewritten: mergeNumbers(base?.rewritten ?? [], payload.rewritten),
      step,
      frontier: {
        down: payload.frontier.backward ?? step ?? payload.origin,
        up: payload.frontier.forward ?? step ?? payload.origin,
      },
      seams: mergeSeams(base?.seams ?? [], payload.seamsOut),
    };
  }

  if (event.type === 'change:decided') {
    const payload = event.data as ChangeDecidedPayload;
    if (current === null || current.changeId !== payload.id) return null;
    const cascade = payload.cascade;
    return {
      ...current,
      status: payload.outcome === 'escalated' ? 'escalated' : 'closed',
      outcome: payload.outcome,
      touched: cascade === null ? current.touched : mergeNumbers(current.touched, cascade.touched),
      rewritten: cascade === null ? current.rewritten : mergeNumbers(current.rewritten, cascade.rewritten),
      seams:
        cascade === null
          ? current.seams.map((seam) => ({ ...seam, resolved: payload.outcome !== 'escalated' }))
          : resolveSeams(current.seams, cascade.seams, payload.outcome !== 'escalated'),
      step: null,
    };
  }

  return current;
}

/** The decision frame carries only `{boundary, resolved}`; the ribbon keeps its own clause. */
function resolveSeams(
  current: RibbonSeam[],
  decided: Array<{ boundary: SeamBoundary; resolved: boolean }>,
  fallback: boolean,
): RibbonSeam[] {
  const resolved = new Map(decided.map((seam) => [seam.boundary, seam.resolved]));
  return current.map((seam) => ({ ...seam, resolved: resolved.get(seam.boundary) ?? fallback }));
}

// ── escalation markers (§11.7) ───────────────────────────────────────────────

export type EscalationMarker = {
  key: string;
  boundary: SeamBoundary;
  percent: number;
  reason: string;
  note: string | null;
  changeId: string | null;
};

/** `n` is the boundary (n−1 | n); `front` is 0 % and `ending` 100 % of the spine. */
export function boundaryPercent(boundary: SeamBoundary): number {
  if (boundary === 'front') return 0;
  if (boundary === 'ending') return 100;
  return ((boundary - 1) / TOTAL_CHAPTERS) * 100;
}

export function escalationMarkers(unresolved: StateSnapshot['unresolved']): EscalationMarker[] {
  const markers = new Map<string, EscalationMarker>();
  for (const entry of unresolved) {
    const key = `${entry.changeId ?? 'unknown'}:${String(entry.boundary)}`;
    if (markers.has(key)) continue;
    markers.set(key, {
      key,
      boundary: entry.boundary,
      percent: boundaryPercent(entry.boundary),
      reason: entry.reason,
      note: entry.note ?? null,
      changeId: entry.changeId,
    });
  }
  return [...markers.values()];
}

// ── copy and geometry for the header ─────────────────────────────────────────

export function ribbonBand(ribbon: Ribbon): { left: string; width: string } {
  const touched = ribbon.touched.length > 0 ? ribbon.touched : [ribbon.chapter];
  const left = chapterPercent(Math.min(...touched));
  const right = chapterPercent(Math.max(...touched));
  return { left: `${left}%`, width: `${Math.max(0.4, right - left)}%` };
}

export function ribbonDotPercent(chapter: number): number {
  return chapterPercent(chapter);
}

/** «глава 8 → 7 и 9, дальше держится» — the ribbon's own words (§11.7, §21.6). */
export function ribbonSummary(ribbon: Ribbon): string {
  const wings = ribbon.touched.filter((chapter) => chapter !== ribbon.chapter);
  const route =
    wings.length === 0
      ? `глава ${ribbon.chapter}`
      : `глава ${ribbon.chapter} → ${wings.length === 1 ? String(wings[0]) : `${wings.slice(0, -1).join(', ')} и ${String(wings.at(-1))}`}`;
  if (ribbon.status === 'escalated') return `правка: ${route} · стык пересматривается`;
  if (ribbon.status === 'closed') return `правка: ${route} · завершена`;
  return `правка: ${route}`;
}
