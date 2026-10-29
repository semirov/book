/**
 * The cascade ribbon and its escalation markers (ARCHITECTURE.md §11.7, BOOK-DOC-4).
 *
 * Pure geometry and a small reducer, so "the consequence runs in both directions at once"
 * can be asserted without a DOM. A ripple has **two wings** — down toward chapter 1 and up
 * toward chapter 42 — and each wing carries its own wave, state and reached chapters, taken
 * from the real cascade DTO (`state.cascade`, `cascade:progress`, `change:decided`) and never
 * from a timer. A wing that never opened is `waiting` with nothing reached: no rings.
 *
 * `state.cascade` is the authority after a reconnect; while a socket is live,
 * `change:processing` / `cascade:progress` / `change:decided` move the ribbon. A queued
 * change is never drawn here — it has no place yet (§11.7).
 */

import {
  CASCADE_MAX_WAVE,
  STATE_WORDS,
  type CascadeWingDto,
  type CascadeWingsDto,
  type CascadeProgressPayload,
  type ChangeDecidedPayload,
  type ChangeProcessingPayload,
  type SeamBoundary,
  type StateSnapshot,
} from '@book/shared';

/**
 * The ripple bound only for the frames painted *before* `hello` says what the server's own
 * bound is (§6D.2, BOOK-DOC-4 rule 3): the shipped default, never a second number to keep
 * in step by hand.
 */
export const RIBBON_MAX_WAVE = CASCADE_MAX_WAVE;

/** The server's wave bound (`hello.limits.maxWave`), with the fallback for a missing value. */
export function ribbonMaxWave(announced: unknown): number {
  // The boot pins the server to `CASCADE_MAX_WAVE`, so the fallback cannot hide a divergence.
  return typeof announced === 'number' && Number.isInteger(announced) && announced > 0
    ? announced
    : RIBBON_MAX_WAVE;
}

export type RibbonSeam = { boundary: SeamBoundary; reason: string; resolved: boolean };

/** A wing's public facts — the same struct the DTOs carry, so nothing is re-derived by guess. */
export type RibbonWing = CascadeWingDto;

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
  /** Both wings at once: the downward frontier toward 1, the upward one toward 42. */
  wings: CascadeWingsDto;
  /** The chapter of the step in flight; null when the ripple is between steps. */
  step: number | null;
  frontier: { down: number; up: number };
  seams: RibbonSeam[];
};

export type RibbonEvent = { type: string; data: unknown };

function waitingWings(origin: number): CascadeWingsDto {
  const wing = (): CascadeWingDto => ({ frontier: origin, wave: 0, state: 'waiting', reached: [] });
  return { down: wing(), up: wing() };
}

/** `down` runs toward chapter 1, `up` toward 42 — the two directions of one consequence. */
export type Wing = 'down' | 'up';

export const WING_WORDS: Record<Wing, string> = { down: 'вниз', up: 'вверх' };

/** Which wing a chapter is reached by, relative to the chapter the change landed in. */
export function wingOfChapter(chapter: number, origin: number): Wing | 'origin' {
  if (chapter === origin) return 'origin';
  return chapter < origin ? 'down' : 'up';
}

/**
 * The wing's one-word state; never a percentage and never a verdict. A wing that has finished
 * its work has «остановилось» — the verb's tense is the finality, not a colour (BOOK-70).
 *
 * BOOK-137 — a wing that **never opened** says nothing at all: «не открылось» is the
 * machinery reporting its own condition, and no reading surface prints a failure. The origin
 * («65 правка») stays; an empty wing is simply absent.
 */
export function wingStateCopy(state: CascadeWingDto['state']): string {
  if (state === 'waiting') return '';
  if (state === 'moving') return STATE_WORDS.reading;
  if (state === 'stopped') return 'остановлено';
  return 'остановилось';
}

/**
 * «вниз · идёт» / «вниз · волна 2 · решением · идёт» — the wing's own line, for the ribbon and
 * the focus view. BOOK-59: a wave below two is the only wave a ripple has, so it is noise; a
 * second one got there by the owner's decision and says so. BOOK-137: a wing that never
 * opened prints nothing — the callers skip the empty slot instead of drawing a blank or a
 * diagnostic.
 */
export function wingLine(side: Wing, wing: RibbonWing): string {
  if (wing.state === 'waiting') return '';
  const wave = wing.wave >= 2 ? ` · волна ${wing.wave} · решением` : '';
  return `${WING_WORDS[side]}${wave} · ${wingStateCopy(wing.state)}`;
}

/**
 * «07 · 06» — reached chapters, nearest first. An empty wing prints nothing at all: the state
 * line carries the state, and a second word is the same fact twice, while «дальше держится»
 * is a claim the data does not make (BOOK-70).
 */
export function wingReachedCopy(wing: RibbonWing): string {
  if (wing.reached.length === 0) return '';
  return wing.reached.map((chapter) => String(chapter).padStart(2, '0')).join(' · ');
}

/** True while a ripple is actually moving: the only case that may draw a ring. */
export function rippleIsLive(ribbon: Ribbon | null): boolean {
  return ribbon !== null && ribbon.status === 'open' && ribbon.step !== null;
}

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
    wings: cascade.wings,
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
      wings: waitingWings(payload.chapter),
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
      wings: payload.wings,
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
      wings: cascade === null ? current.wings : cascade.wings,
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
  reason: string;
  note: string | null;
  changeId: string | null;
};

/** One marker per unresolved seam; the seam is named by its two chapters, never by a percent. */
export function escalationMarkers(unresolved: StateSnapshot['unresolved']): EscalationMarker[] {
  const markers = new Map<string, EscalationMarker>();
  for (const entry of unresolved) {
    const key = `${entry.changeId ?? 'unknown'}:${String(entry.boundary)}`;
    if (markers.has(key)) continue;
    markers.set(key, {
      key,
      boundary: entry.boundary,
      reason: entry.reason,
      note: entry.note ?? null,
      changeId: entry.changeId,
    });
  }
  return [...markers.values()];
}

// ── copy for the header ──────────────────────────────────────────────────────

/** «правка: глава 8 · вниз до главы 7 · вверх до главы 9» — both wings, never a percentage. */
export function ribbonSummary(ribbon: Ribbon): string {
  const parts = [`правка: глава ${ribbon.chapter}`];
  if (ribbon.wings.down.reached.length > 0) parts.push(`вниз до главы ${ribbon.wings.down.frontier}`);
  if (ribbon.wings.up.reached.length > 0) parts.push(`вверх до главы ${ribbon.wings.up.frontier}`);
  if (ribbon.status === 'escalated') return `${parts.join(' · ')} · стык пересматривается`;
  if (ribbon.status === 'closed') return `${parts.join(' · ')} · завершена`;
  return parts.join(' · ');
}
