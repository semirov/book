/**
 * The cached snapshot served at `GET /api/state`. Recomputes from the projection, bumps
 * `version` only when the derived content actually changed (§7.2 rule 10), and persists
 * the counter so a restart cannot hand a client a lower version.
 */

import type { StateSnapshot } from '@book/shared';

import type { Db } from '../db/db.ts';
import { listCatalog } from '../db/repo/chapters.ts';
import { getFrontRow } from '../db/repo/front.ts';
import { getNumber, setMeta } from '../db/repo/meta.ts';
import { readEngineOverlay } from '../engineState/reader.ts';
import { type ChapterFact, type FrontFact, deriveState, stateFingerprint } from './stateMachine.ts';

export class StateService {
  private cached: StateSnapshot | null = null;
  private fingerprint = '';

  constructor(
    private readonly db: Db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  facts(): ChapterFact[] {
    return listCatalog(this.db)
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

  snapshot(): StateSnapshot {
    const facts = this.facts();
    const front = this.front();
    const overlay = readEngineOverlay(this.db, this.clock().getTime());
    const fingerprint = stateFingerprint(facts, front, overlay.fingerprint);
    if (this.cached !== null && fingerprint === this.fingerprint) return this.cached;

    const version = getNumber(this.db, 'state_version', 0) + 1;
    setMeta(this.db, 'state_version', String(version));
    const snapshot = deriveState({ facts, front, now: this.clock(), version, overlay });
    this.cached = snapshot;
    this.fingerprint = fingerprint;
    return snapshot;
  }
}
