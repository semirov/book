/**
 * The focus view's pure vocabulary (ARCHITECTURE.md §11.9, ADR-032, DESIGN §7.14).
 *
 * The focus view is a mode of the same page, selected by `#правка-<changeId>`. Everything
 * here is a function of payloads already on the site — the change DTO, its impact, the
 * ribbon and the revision frames — so the stage, the wings, the sheet and the changed
 * blocks can be asserted without a browser or a socket.
 *
 * No field in these inputs can carry a gate verdict, a finding or a hidden role (§6B.6):
 * the DTOs have none. The focus view is a reading surface; it never invents a claim about
 * the model's keystrokes (§2, ADR-006, §21.6).
 */

import {
  CHANGE_RECORD_PREFIX,
  TOTAL_CHAPTERS,
  chapterLabel,
  type BlockDto,
  type CascadeWingDto,
  type CascadeWingsDto,
  type ChangeDto,
  type ChangeImpactDto,
  type HistoryDiffOpDto,
  type PatchOp,
} from '@book/shared';

import { RIBBON_MAX_WAVE, type Ribbon } from './cascade.ts';
import { changeNumber, relevanceCopy, stampCopy } from './changeStatus.ts';
import { NBSP, formatNumber, formatTime, plural } from './format.ts';

/** The only deep link the focus view needs; Cyrillic is part of the URL on purpose. */
export const FOCUS_PREFIX = CHANGE_RECORD_PREFIX;

export function focusHash(changeId: string): string {
  return `#${FOCUS_PREFIX}${changeId}`;
}

/** `#правка-chg_1` → `chg_1`; any other hash (or a malformed one) is not a focus link. */
export function parseFocusHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* a broken escape sequence is not a change id */
  }
  if (!decoded.startsWith(FOCUS_PREFIX)) return null;
  const id = decoded.slice(FOCUS_PREFIX.length);
  if (id.length === 0 || id.length > 80) return null;
  if (!/^[A-Za-z0-9_-]+$/u.test(id)) return null;
  return id;
}

// ── stage ────────────────────────────────────────────────────────────────────

/**
 * The stage vocabulary of §11.9: очередь · основа изменилась · правка · вниз · вверх ·
 * готово. `escalated`, `void` and `failed` are terminal states with their own word.
 */
export type FocusStage = 'queue' | 'stale' | 'edit' | 'down' | 'up' | 'done' | 'escalated' | 'void' | 'failed';

export function focusStage(
  change: Pick<ChangeDto, 'id' | 'status' | 'outcome'>,
  ribbon: Ribbon | null,
): FocusStage {
  if (change.status === 'pending') return 'queue';
  if (change.status === 'stale') return 'stale';
  if (change.status === 'escalated') return 'escalated';
  if (change.status === 'failed') return 'failed';
  if (change.status === 'void') return 'void';
  if (change.status === 'done') {
    return change.outcome === 'dropped' || change.outcome === 'superseded' ? 'void' : 'done';
  }
  // `processing`: the wing comes from where the ripple's step sits relative to the origin.
  if (ribbon === null || ribbon.changeId !== change.id || ribbon.step === null) return 'edit';
  if (ribbon.step < ribbon.chapter) return 'down';
  if (ribbon.step > ribbon.chapter) return 'up';
  return 'edit';
}

export function stageCopy(stage: FocusStage): string {
  switch (stage) {
    case 'queue':
      return 'очередь';
    case 'stale':
      return 'основа изменилась';
    case 'edit':
      return 'правка';
    case 'down':
      return 'вниз';
    case 'up':
      return 'вверх';
    case 'done':
      return 'готово';
    case 'escalated':
      return 'ждёт решения';
    case 'void':
      return 'снято';
    case 'failed':
      return 'не внесено';
    default:
      return 'правка';
  }
}

// ── wings and the sheet ──────────────────────────────────────────────────────

export type FocusWings = { down: number | null; up: number | null };

/**
 * «вниз: глава 7 · вверх: глава 9». The live ribbon wins while it is moving; a completed
 * change falls back to its steps, which is the same fact written down.
 */
export function focusWings(
  change: Pick<ChangeDto, 'id' | 'chapter' | 'steps'>,
  ribbon: Ribbon | null,
): FocusWings {
  let down: number | null = null;
  let up: number | null = null;

  if (ribbon !== null && ribbon.changeId === change.id) {
    for (const chapter of ribbon.touched) {
      if (chapter === ribbon.chapter) continue;
      if (chapter < ribbon.chapter) down = down === null ? chapter : Math.min(down, chapter);
      if (chapter > ribbon.chapter) up = up === null ? chapter : Math.max(up, chapter);
    }
  }

  for (const step of change.steps) {
    if (typeof step.chapter !== 'number') continue;
    if (step.wing === 'downward') down = down === null ? step.chapter : Math.min(down, step.chapter);
    if (step.wing === 'upward') up = up === null ? step.chapter : Math.max(up, step.chapter);
  }

  return { down, up };
}

/**
 * The two wings the panel prints. A live ripple wins while the change is processing (the
 * frames are fresher than the fetched DTO); otherwise the cascade's own record is the truth.
 * A change that raised no ripple has two wings that never opened — and says exactly that.
 */
export function focusWingPair(
  change: Pick<ChangeDto, 'id' | 'chapter' | 'status' | 'cascade' | 'steps'>,
  ribbon: Ribbon | null,
): CascadeWingsDto {
  const live = ribbon !== null && ribbon.changeId === change.id ? ribbon.wings : null;
  if (change.status === 'processing' && live !== null) return live;
  if (change.cascade !== null) return change.cascade.wings;
  if (live !== null) return live;
  const waiting = (): CascadeWingDto => ({ frontier: change.chapter, wave: 0, state: 'waiting', reached: [] });
  return { down: waiting(), up: waiting() };
}

/**
 * The chapter the lit sheet shows. Following wins while the ripple is live (`ribbon.step`);
 * a manual pick, once made, stays until «следовать» is turned back on.
 */
export function sheetChapter(
  change: Pick<ChangeDto, 'id' | 'chapter' | 'status' | 'steps'>,
  ribbon: Ribbon | null,
  manual: number | null,
): number {
  if (manual !== null) return manual;
  if (ribbon !== null && ribbon.changeId === change.id && change.status === 'processing' && ribbon.step !== null) {
    return ribbon.step;
  }
  for (const step of change.steps) {
    if (typeof step.chapter !== 'number') continue;
    if (step.outcome === 'rewritten' || step.outcome === 'published_with_finding') return step.chapter;
  }
  for (const step of change.steps) if (typeof step.chapter === 'number') return step.chapter;
  return change.chapter;
}

/** A change whose steps can have landed blocks to print. A dropped or stale one cannot. */
export function canPrint(change: Pick<ChangeDto, 'status' | 'outcome'>): boolean {
  if (change.status === 'processing') return true;
  if (change.status !== 'done') return false;
  return change.outcome !== 'dropped' && change.outcome !== 'superseded';
}

// ── the changed blocks (never the chapter) ───────────────────────────────────

export type FocusBlock = { id: string; text: string; op: 'added' | 'replaced' | 'removed' };

/** The live path: a `chapter:revision` patch already names exactly the blocks that moved. */
export function blocksFromPatch(patch: readonly PatchOp[]): FocusBlock[] {
  const blocks: FocusBlock[] = [];
  const seen = new Set<string>();
  for (const op of patch) {
    if (op.op === 'remove') {
      if (!seen.has(op.id)) {
        seen.add(op.id);
        blocks.push({ id: op.id, text: '', op: 'removed' });
      }
      continue;
    }
    if (typeof op.newId !== 'string' || typeof op.text !== 'string') continue;
    if (seen.has(op.newId)) continue;
    seen.add(op.newId);
    blocks.push({ id: op.newId, text: op.text, op: op.op === 'insert' ? 'added' : 'replaced' });
  }
  return blocks;
}

/**
 * The landed path: the change log for the change's span names the blocks; the chapter at
 * `toHseq` supplies their text. Removals stay as a marker — there is no text to print.
 */
export function changedBlocksFromDiff(
  ops: readonly HistoryDiffOpDto[],
  chapter: number,
  blocks: readonly BlockDto[],
): FocusBlock[] {
  const added = new Set<string>();
  const replaced = new Set<string>();
  const removed = new Set<string>();
  for (const op of ops) {
    if (op.chapter !== chapter) continue;
    if (op.op === 'added') {
      added.add(op.blockId);
      continue;
    }
    if (op.op === 'replaced') {
      if (op.replacedBy === null) {
        removed.add(op.blockId);
      } else {
        added.add(op.replacedBy);
        replaced.add(op.replacedBy);
      }
      continue;
    }
    removed.add(op.blockId);
  }

  const out: FocusBlock[] = [];
  for (const block of [...blocks].sort((left, right) => left.i - right.i)) {
    if (!added.has(block.id)) continue;
    out.push({ id: block.id, text: block.text, op: replaced.has(block.id) ? 'replaced' : 'added' });
  }
  for (const id of removed) out.push({ id, text: '', op: 'removed' });
  return out;
}

// ── the panel's lines ────────────────────────────────────────────────────────

export function waveOf(change: Pick<ChangeDto, 'cascade' | 'steps'>): number {
  if (change.cascade !== null) return change.cascade.wave;
  return change.steps.reduce((max, step) => Math.max(max, step.wave), 0);
}

/** «сноска 014» — the iteration number the SPEC makes every change carry. */
export function footnoteCopy(change: Pick<ChangeDto, 'seq'>): string {
  return `сноска ${changeNumber(change.seq)}`;
}

/**
 * BOOK-59 — the wave, only when it is news. A ripple is one wave, so «волна 1» is noise and a
 * denominator is never printed; a **second** wave exists only because the owner decided to
 * open one, and that is the only wave number a reader ever needs to see.
 */
export function waveCopy(wave: number, maxWave: number = RIBBON_MAX_WAVE): string {
  if (wave < 2) return '';
  // A bound above one is not shipped (config refuses it), but if a frame ever announces it,
  // the number is not a decision and must not claim one.
  return maxWave <= 1 ? `волна ${wave} · решением` : `волна ${wave}`;
}

/** «этап: готово» / «волна 2 · решением · этап: готово» — the assessed effect, never a verdict. */
export function assessmentCopy(
  change: Pick<ChangeDto, 'id' | 'status' | 'outcome' | 'cascade' | 'steps'>,
  ribbon: Ribbon | null,
  maxWave: number = RIBBON_MAX_WAVE,
  history = true,
): string {
  const stage = stageCopy(focusStage(change, ribbon));
  // BOOK-56: with history off the cascade is not narrated — the stage word still is.
  if (!history) return `этап: ${stage}`;
  const wave = waveCopy(waveOf(change), maxWave);
  return wave === '' ? `этап: ${stage}` : `${wave} · этап: ${stage}`;
}

/** «замечание Ани · глава 8 · принято 12:04» — the basis, as the thread knows it. */
export function basisCopy(change: Pick<ChangeDto, 'source' | 'chapter' | 'enqueuedAt'>): string {
  const who = change.source.author === null ? 'формулировка автора' : `замечание ${change.source.author}`;
  return `${who} · глава ${change.chapter} · принято ${formatTime(change.enqueuedAt)}`;
}

/** «08 · 09 · 07 (проверена)» — touched chapters, with the checked ones marked. */
export function touchedChaptersCopy(
  change: Pick<ChangeDto, 'chapter' | 'steps' | 'cascade'>,
  impact: Pick<ChangeImpactDto, 'chaptersTouched'> | null,
): string {
  const chapters = new Set<number>(impact?.chaptersTouched ?? [change.chapter]);
  for (const step of change.steps) if (typeof step.chapter === 'number') chapters.add(step.chapter);
  const checked = new Set<number>(change.cascade?.chaptersChecked ?? []);
  return [...chapters]
    .sort((left, right) => left - right)
    .map((n) => `${chapterLabel(n)}${checked.has(n) ? ' (проверена)' : ''}`)
    .join(' · ');
}

/**
 * The honest money line: the tokens, and the rubles **only when they were measured**
 * (BOOK-DOC-4 «Honesty about cost», BOOK-23). `rub: null` is «not measured» and prints no ₽
 * figure at all; the number `0` is a measured price of zero and prints «0,00 ₽». One rule for
 * the card and the focus view, so neither can invent a zero of its own.
 *
 * The model id is **not** printed (owner, 2026-10-28): the reader's surface never names the
 * writer. The DTO still carries `cost.model` — the wire is the workshop's — and that field is
 * what the change card and the pass record must not print.
 */
export function costLine(
  change: Pick<ChangeDto, 'cost'>,
  impact: Pick<ChangeImpactDto, 'tokens' | 'costRub'> | null,
): string | null {
  const cost = change.cost;
  const tokens = cost === null ? (impact === null ? null : impact.tokens) : cost.tokensIn + cost.tokensOut;
  const rub = cost === null ? (impact === null ? null : impact.costRub) : cost.rub;
  const parts: string[] = [];
  if (tokens !== null && tokens > 0) parts.push(`${formatNumber(tokens)}${NBSP}${plural(tokens, 'токен', 'токена', 'токенов')}`);
  if (typeof rub === 'number' && Number.isFinite(rub) && rub >= 0) {
    parts.push(`${rub.toFixed(2).replace('.', ',')}${NBSP}₽`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * What the lit sheet says when there is nothing to print. Every degenerate case named in
 * §11.9 has its own line; none of them pretends to type.
 */
export function sheetNotice(
  change: Pick<ChangeDto, 'status' | 'outcome' | 'position' | 'reason' | 'relevance'>,
): string | null {
  switch (change.status) {
    case 'pending':
      return `правка в очереди · ${change.position ?? 1}-я`;
    case 'stale':
      return `основа изменилась · ${change.relevance === null ? 'сверяется' : relevanceCopy(change.relevance.grade)}`;
    case 'escalated':
      return 'правка ждёт решения автора';
    case 'failed':
      return 'не удалось внести · замечание сохранено';
    case 'void':
      return change.outcome === 'superseded' ? 'правка перекрыта более поздней' : 'снято · текст менять не нужно';
    case 'done':
      return change.outcome === 'dropped' || change.outcome === 'superseded' ? 'снято · текст менять не нужно' : null;
    default:
      return null;
  }
}

/** The stamp in the panel's corner: the same word the card and the thread use. */
export function panelStamp(change: Pick<ChangeDto, 'status' | 'outcome'>): string {
  return stampCopy(change);
}

/** The lit sheet's line when there is nothing to print; a dropped change names its reason. */
export function sheetCopy(
  notice: string | null,
  reason: string | null,
  loading: boolean,
  status: ChangeDto['status'],
): string {
  if (loading) return 'изменённые абзацы читаются';
  if (notice !== null) return reason === null ? notice : `${notice} · ${reason}`;
  if (status === 'processing') return 'правка идёт · текст появится, когда шаг закроется';
  return 'изменённых абзацев нет';
}

// ── the ring field ───────────────────────────────────────────────────────────

/** A local window around the ripple, so 7–9 do not collapse into one pixel of a 42-chapter scale. */
export function focusScale(chapters: readonly number[], pad = 2): { from: number; to: number } {
  const valid = chapters.filter((n) => Number.isInteger(n) && n >= 1 && n <= TOTAL_CHAPTERS);
  if (valid.length === 0) return { from: 1, to: 5 };
  return {
    from: Math.max(1, Math.min(...valid) - pad),
    to: Math.min(TOTAL_CHAPTERS, Math.max(...valid) + pad),
  };
}

/** Every chapter of a local window as a tick; a very wide window has no labels to draw. */
export function scaleTicks(from: number, to: number): number[] {
  if (to < from || to - from > 10) return [];
  const out: number[] = [];
  for (let n = from; n <= to; n += 1) out.push(n);
  return out;
}

/** Where the reader goes when the focus view closes (§11.9 rule 6). */
export type FocusExit = { kind: 'offset'; offset: number } | { kind: 'chapter'; chapter: number };

export function exitTarget(savedOffset: number, chapter: number | null): FocusExit {
  return chapter === null ? { kind: 'offset', offset: savedOffset } : { kind: 'chapter', chapter };
}
