/**
 * The cached snapshot served at `GET /api/state`. Recomputes from the projection, bumps
 * `version` only when the derived content actually changed (§7.2 rule 10), and persists
 * the counter so a restart cannot hand a client a lower version.
 *
 * BOOK-117: the money block is added here, from the same ledger reader the engine's guard
 * uses (`budgetSnapshot`) — the site never computes money itself. It is part of the
 * fingerprint, so a pass that spends bumps the version and the ETag rather than being hidden
 * behind a cached snapshot.
 */

import type { CatalogEntry, StateSnapshot } from '@book/shared';

import { DEFAULT_BUDGET_CAPS, budgetSnapshot, type BudgetCaps } from '../budget.ts';
import type { Db } from '../db/db.ts';
import { listCatalog } from '../db/repo/chapters.ts';
import { getFrontRow } from '../db/repo/front.ts';
import { getNumber, setMeta } from '../db/repo/meta.ts';
import { readEngineOverlay } from '../engineState/reader.ts';
import { countReaderChanges, firstEventAt } from '../history/live.ts';
import { type ChapterFact, type FrontFact, deriveState, stateFingerprint } from './stateMachine.ts';

export class StateService {
  private cached: StateSnapshot | null = null;
  private fingerprint = '';

  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
    private readonly caps: BudgetCaps = DEFAULT_BUDGET_CAPS,
  ) {}

  /**
   * The written chapters as facts. `catalog` is the caller's snapshot when it already read one:
   * `snapshot()` reads the catalogue once and derives both lists from that one answer, so a
   * request never pays two scans for the same page.
   */
  facts(catalog: readonly CatalogEntry[] = listCatalog(this.db)): ChapterFact[] {
    return catalog
      .filter((entry) => entry.written && entry.updatedAt !== null && entry.writtenAt !== null)
      .map((entry) => ({
        n: entry.n,
        rev: entry.rev,
        title: entry.title,
        chars: entry.chars,
        blocks: entry.blocks,
        writtenAt: entry.writtenAt as string,
        updatedAt: entry.updatedAt as string,
      }));
  }

  /** Slots that hold only their basis sentence (ch01/ch42): empty of prose, readable (BOOK-6). */
  basis(catalog: readonly CatalogEntry[] = listCatalog(this.db)): number[] {
    return catalog.filter((entry) => entry.basis).map((entry) => entry.n);
  }

  front(): FrontFact {
    const row = getFrontRow(this.db);
    if (row === undefined) return { title: null, about: null, rev: 0, updatedAt: null };
    return {
      title: row.title.length > 0 ? row.title : null,
      about: row.about.length > 0 ? row.about : null,
      rev: row.rev,
      updatedAt: row.updated_at,
    };
  }

  /** The current version without recomputing; `null` before the first snapshot. */
  currentVersion(): number | null {
    return this.cached?.version ?? null;
  }

  /** BOOK-56: the one derived fact behind every history surface (0 keeps history off). */
  readerChanges(): number {
    return countReaderChanges(this.db);
  }

  /** BOOK-56: the log has begun, so the chronicle exists from its first record. */
  started(): boolean {
    return firstEventAt(this.db) !== null;
  }

  snapshot(): StateSnapshot {
    // One catalogue for both lists: `facts` and `basis` are two projections of the same answer
    // (`listFirstBlockTexts` is a query, not a per-chapter loop), so the page pays it once.
    const catalog = listCatalog(this.db);
    const facts = this.facts(catalog);
    const basis = this.basis(catalog);
    const front = this.front();
    const readerChanges = this.readerChanges();
    const started = this.started();
    const now = this.clock();
    const overlay = readEngineOverlay(this.db, now.getTime());
    // BOOK-117: the one money answer, from the ledger; a spend moves the fingerprint, so the
    // version and the ETag move with it.
    const budget = budgetSnapshot(this.db, this.caps, now.getTime());
    const fingerprint = `${stateFingerprint(facts, front, overlay.fingerprint, basis, readerChanges, started)}|${budget.state}|${budget.line}|${String(budget.book.spentUsd)}|${String(budget.tokens.today)}`;
    if (this.cached !== null && fingerprint === this.fingerprint) return this.cached;

    const version = getNumber(this.db, 'state_version', 0) + 1;
    setMeta(this.db, 'state_version', String(version));
    const snapshot = { ...deriveState({ facts, basis, front, now, version, overlay, readerChanges, started }), budget };
    this.cached = snapshot;
    this.fingerprint = fingerprint;
    return snapshot;
  }
}
