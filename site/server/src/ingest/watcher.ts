/**
 * The watcher (ARCHITECTURE.md §6.1–6.2, §7 M2): chokidar in polling mode because
 * fsevents do not reliably cross the OrbStack VM boundary, one path at a time, bursts
 * coalesced, and the same per-file ingestion the boot scan uses.
 *
 * It reports facts, never inference: a write that matches no live lease is published and
 * flagged `attributed: false` (leases arrive with the engine in M3).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import chokidar, { type FSWatcher } from 'chokidar';

import {
  FRONT_FILE,
  directionOf,
  isChapterNumber,
  partOf,
  type ChapterCreatedPayload,
  type ChapterRevisionPayload,
  type FrontUpdatedPayload,
  type StateUpdatedPayload,
} from '@book/shared';

import type { Db } from '../db/db.ts';
import { getChapterRow } from '../db/repo/chapters.ts';
import { chapterEtag } from '../util/etag.ts';
import { toIso } from '../util/time.ts';
import { type AppliedChapter, applyChapterFile, removeChapter } from './applyChapter.ts';
import { applyFrontFile, removeFront } from './applyFront.ts';
import { frontWriteCause, type WriteCause } from './attribution.ts';
import { parseChapter } from './parseChapter.ts';
import type { StateService } from './stateService.ts';

export type IngestEvent =
  | { type: 'chapter:created'; data: ChapterCreatedPayload }
  | { type: 'chapter:revision'; data: ChapterRevisionPayload }
  | { type: 'front:updated'; data: FrontUpdatedPayload }
  | { type: 'state:updated'; data: StateUpdatedPayload };

export type WatcherStatus = {
  lastTickAt: string | null;
  lastEventAt: string | null;
  /** The `manuscript/` directory itself is absent (a bad mount) — not an empty book. */
  missing: boolean;
};

export type WatcherOptions = {
  db: Db;
  state: StateService;
  bookRoot: string;
  dataDir: string;
  /** Poll interval; 700 ms in production (§6.2). */
  pollMs?: number;
  /** chokidar's write-stability window; 300 ms in production. */
  stabilityMs?: number;
  /** Collapses a truncate-then-write burst into one revision; 1 500 ms in production. */
  coalesceMs?: number;
  /** How long to wait for a follow-up write before keeping the previous revision (§6.2). */
  emptyGraceMs?: number;
  now?: () => Date;
  emit: (event: IngestEvent) => void;
  log?: (message: string, meta?: Record<string, unknown>) => void;
};

const DEFAULT_COALESCE_MS = 1_500;
const DEFAULT_EMPTY_GRACE_MS = 5_000;
const CHAPTER_FILE = /^ch(\d{2})\.md$/u;

type PendingKind = 'add' | 'change' | 'unlink';

/** `ch08.md` → `8`; anything else in `manuscript/` → null (it is ignored, F002 reports it). */
export function chapterNumberOf(path: string): number | null {
  const match = CHAPTER_FILE.exec(path);
  if (match === null) return null;
  const n = Number.parseInt(match[1] ?? '', 10);
  return isChapterNumber(n) ? n : null;
}

/**
 * §6.2: dotfiles, editor temporaries, `archive/` and every non-book file are invisible to
 * the watcher. The manuscript may contain *nothing* else, so an ignored path is a
 * validator finding, not a source of state.
 */
export function isIgnoredPath(path: string, root: string): boolean {
  if (path === root) return false;
  const name = basename(path);
  if (/[/\\]archive[/\\]/u.test(path)) return true;
  if (name === FRONT_FILE) return false;
  if (CHAPTER_FILE.test(name)) return chapterNumberOf(name) === null;
  if (name.startsWith('.')) return true;
  if (name.endsWith('~') || /\.(tmp|swp|swx)$/u.test(name)) return true;
  return true;
}

export class ManuscriptWatcher {
  readonly status: WatcherStatus = { lastTickAt: null, lastEventAt: null, missing: false };

  private readonly db: Db;
  private readonly state: StateService;
  private readonly bookRoot: string;
  private readonly dataDir: string;
  private readonly pollMs: number;
  private readonly stabilityMs: number;
  private readonly coalesceMs: number;
  private readonly emptyGraceMs: number;
  private readonly now: () => Date;
  private readonly emit: (event: IngestEvent) => void;
  private readonly log: (message: string, meta?: Record<string, unknown>) => void;

  private watcher: FSWatcher | null = null;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly kinds = new Map<string, PendingKind>();
  private readonly emptyWaited = new Set<string>();
  /** The grace window expired; the next observation records `parse_error` once. */
  private readonly emptyFinal = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private lastVersion: number | null = null;
  private stopped = false;

  constructor(options: WatcherOptions) {
    this.db = options.db;
    this.state = options.state;
    this.bookRoot = options.bookRoot;
    this.dataDir = options.dataDir;
    this.pollMs = options.pollMs ?? 700;
    this.stabilityMs = options.stabilityMs ?? 300;
    this.coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
    this.emptyGraceMs = options.emptyGraceMs ?? DEFAULT_EMPTY_GRACE_MS;
    this.now = options.now ?? (() => new Date());
    this.emit = options.emit;
    this.log = options.log ?? (() => undefined);
  }

  get manuscriptDir(): string {
    return join(this.bookRoot, 'manuscript');
  }

  /** Resolves when chokidar is attached, so a caller can write immediately after boot. */
  async start(): Promise<void> {
    const dir = this.manuscriptDir;
    this.status.missing = !existsSync(dir);
    this.lastVersion = this.state.snapshot().version;

    if (this.status.missing) {
      this.log('manuscript directory is missing: the site keeps the last known text', { dir });
    }

    const watcher = chokidar.watch(dir, {
      usePolling: true,
      interval: this.pollMs,
      binaryInterval: Math.max(2_000, this.pollMs * 2),
      awaitWriteFinish: { stabilityThreshold: this.stabilityMs, pollInterval: 100 },
      ignoreInitial: true,
      ignored: (path) => isIgnoredPath(path, dir),
    });
    this.watcher = watcher;
    watcher.on('add', (path) => this.queue(path, 'add'));
    watcher.on('change', (path) => this.queue(path, 'change'));
    watcher.on('unlink', (path) => this.queue(path, 'unlink'));
    watcher.on('error', (error) => this.log('watcher error', { error: String(error) }));
    await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
    // A write between the boot scan and `ready` must not be lost: read what is on disk now.
    // Idempotent by sha, so unchanged files emit nothing.
    this.catchUp();
    this.log('watching manuscript', { dir, pollMs: this.pollMs });
  }

  /** Re-read the directory once after `ready`: covers a write during the initial scan. */
  private catchUp(): void {
    const dir = this.manuscriptDir;
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (isIgnoredPath(path, dir)) continue;
      try {
        this.process(path);
      } catch (error) {
        this.log('catch-up failed', { path, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  async stop(): Promise<void> {    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.chain.catch(() => undefined);
    await this.watcher?.close();
    this.watcher = null;
  }

  private queue(path: string, kind: PendingKind): void {
    if (this.stopped) return;
    this.status.lastTickAt = toIso(this.now());
    this.kinds.set(path, kind);
    const existing = this.timers.get(path);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(path);
      this.chain = this.chain.then(() => this.process(path)).catch((error: unknown) => {
        this.log('ingest failed', { path, error: error instanceof Error ? error.message : String(error) });
      });
    }, this.coalesceMs);
    timer.unref?.();
    this.timers.set(path, timer);
  }

  private async process(path: string): Promise<void> {
    const kind = this.kinds.get(path) ?? 'change';
    this.kinds.delete(path);
    const name = basename(path);

    if (name === FRONT_FILE) {
      if (kind === 'unlink') this.frontRemoved();
      else this.frontObserved(path);
      return;
    }

    const n = chapterNumberOf(name);
    if (n === null) return;
    if (kind === 'unlink') this.chapterRemoved(n);
    else this.chapterObserved(path, n);
  }

  private chapterObserved(path: string, n: number): void {
    this.status.missing = false;
    const observed = this.readWithRetry(path);
    if (observed === null) {
      // The file went away between the event and the read: that is a removal.
      this.chapterRemoved(n);
      return;
    }
    const parsed = parseChapter(n, observed.raw);
    const existing = getChapterRow(this.db, n);

    if (parsed.basis) {
      // §BOOK-6: the file holds only its basis sentence. That is a legitimately empty slot —
      // one paragraph of frozen frame, no title, no chars — not a truncate-then-write, so the
      // §6.2 empty-write guard must not hold it back or resurrect the old text.
      this.emptyWaited.delete(path);
      this.emptyFinal.delete(path);
      const emptied = applyChapterFile({
        db: this.db,
        dataDir: this.dataDir,
        n,
        raw: observed.raw,
        mtimeMs: observed.mtimeMs,
        nowMs: this.now().getTime(),
      });
      if (emptied.status === 'emptied') {
        this.status.lastEventAt = toIso(this.now());
        this.log('chapter reduced to its basis sentence', { n });
        this.emitState('file');
      }
      return;
    }

    if (parsed.blocks.length === 0) {
      // §6.2 empty-write guard: an editor writing the file in two steps must never blank a
      // chapter. A basis-only slot is not one — it has no prose to lose, so an empty file is
      // just an empty slot and must not be stamped with a parse error (BOOK-6).
      if (existing !== undefined && existing.block_count > 0 && existing.basis === 0) {
        if (this.emptyFinal.has(path)) {
          this.emptyFinal.delete(path);
          this.db
            .prepare('UPDATE chapters SET parse_error = ? WHERE n = ?')
            .run('empty write: kept the previous revision', n);
          this.log('empty write kept the previous revision', { n });
          return;
        }
        if (!this.emptyWaited.has(path)) {
          this.emptyWaited.add(path);
          const timer = setTimeout(() => {
            this.emptyWaited.delete(path);
            this.emptyFinal.add(path);
            this.chain = this.chain.then(() => this.process(path)).catch(() => undefined);
          }, this.emptyGraceMs);
          timer.unref?.();
          this.log('empty write: waiting for the follow-up', { n, graceMs: this.emptyGraceMs });
        }
        return;
      }
      // A first write with no block is an empty slot in progress, not `chapter:created`.
      return;
    }
    this.emptyWaited.delete(path);
    this.emptyFinal.delete(path);

    const result = applyChapterFile({
      db: this.db,
      dataDir: this.dataDir,
      n,
      raw: observed.raw,
      mtimeMs: observed.mtimeMs,
      nowMs: this.now().getTime(),
    });
    if (result.status === 'created') {
      this.status.lastEventAt = toIso(this.now());
      this.emit({ type: 'chapter:created', data: createdPayload(result) });
      this.emitState('file');
    } else if (result.status === 'revised') {
      this.status.lastEventAt = toIso(this.now());
      this.emit({ type: 'chapter:revision', data: revisionPayload(result) });
      this.emitState('file');
    }
  }

  private chapterRemoved(n: number): void {
    if (!existsSync(this.manuscriptDir)) {
      // §6.2: a missing directory is a bad mount, not an empty book. Keep the last text.
      this.status.missing = true;
      this.log('manuscript directory disappeared: keeping the last known text', { n });
      return;
    }
    const result = removeChapter(this.db, n);
    if (result.status !== 'removed') return;
    this.status.lastEventAt = toIso(this.now());
    this.log('chapter removed from the projection', { n });
    this.emitState('file');
  }

  private frontObserved(path: string): void {
    this.status.missing = false;
    const observed = this.readWithRetry(path);
    if (observed === null) {
      this.frontRemoved();
      return;
    }
    const result = applyFrontFile({
      db: this.db,
      dataDir: this.dataDir,
      raw: observed.raw,
      mtimeMs: observed.mtimeMs,
      nowMs: this.now().getTime(),
    });
    if (result.status === 'unchanged') return;
    this.status.lastEventAt = toIso(this.now());
    this.emit({
      type: 'front:updated',
      data: {
        title: result.title,
        about: result.about,
        rev: result.rev,
        previousRev: result.previousRev,
        changed: result.changed,
        cause: frontCausePayload(frontWriteCause(this.db, this.now().getTime())),
      },
    });
    this.emitState('file');
  }

  private frontRemoved(): void {
    if (!existsSync(this.manuscriptDir)) {
      this.status.missing = true;
      this.log('manuscript directory disappeared: keeping the last known first sheet');
      return;
    }
    const result = removeFront(this.db);
    if (result.status !== 'removed') return;
    this.status.lastEventAt = toIso(this.now());
    this.emit({
      type: 'front:updated',
      data: {
        title: null,
        about: null,
        rev: 0,
        previousRev: result.rev,
        changed: { title: true, about: true },
        cause: { kind: 'operator', changeId: null, cascadeId: null, stepId: null },
      },
    });
    this.emitState('file');
  }

  private emitState(reason: StateUpdatedPayload['reason']): void {
    const snapshot = this.state.snapshot();
    if (snapshot.version === this.lastVersion) return;
    this.lastVersion = snapshot.version;
    this.emit({ type: 'state:updated', data: { ...snapshot, reason } });
  }

  private readWithRetry(path: string): { raw: string; mtimeMs: number } | null {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const raw = readFileSync(path, 'utf8');
        return { raw, mtimeMs: statSync(path).mtimeMs };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return null;
        if (attempt === 2) {
          this.log('read failed', { path, error: String(error) });
          return null;
        }
      }
    }
    return null;
  }
}

/** `front:updated` carries only what a reader can act on (§10.3). */
function frontCausePayload(cause: WriteCause): FrontUpdatedPayload['cause'] {
  return {
    kind: cause.kind,
    changeId: cause.changeId,
    cascadeId: cause.cascadeId,
    stepId: cause.stepId,
  };
}

function createdPayload(chapter: AppliedChapter): ChapterCreatedPayload {
  return {
    n: chapter.n,
    title: chapter.title,
    rev: chapter.rev,
    chars: chapter.chars,
    part: partOf(chapter.n),
    direction: directionOf(chapter.n),
    cause: chapter.cause,
    // A created chapter is prose: the basis projection never announces itself this way.
    fetch: { path: `/api/chapters/${chapter.n}`, etag: chapterEtag(chapter.n, chapter.rev, false) },
    createdAt: chapter.updatedAt,
    attributed: chapter.attributed,
  };
}

function revisionPayload(chapter: AppliedChapter & { kind: 'edit' | 'rewrite' | 'restore' }): ChapterRevisionPayload {
  return {
    n: chapter.n,
    rev: chapter.rev,
    title: chapter.title,
    chars: chapter.chars,
    delta: chapter.delta,
    kind: chapter.kind,
    cause: {
      changeId: chapter.cause.changeId,
      cascadeId: chapter.cause.cascadeId,
      wave: null,
      lane: chapter.cause.lane ?? directionOf(chapter.n),
      direction: directionOf(chapter.n),
      stepId: chapter.cause.stepId,
      seamsIn: [],
      seamsOut: [],
    },
    patch: chapter.patch,
    patchTruncated: chapter.patchTruncated,
    attributed: chapter.attributed,
    updatedAt: chapter.updatedAt,
  };
}
