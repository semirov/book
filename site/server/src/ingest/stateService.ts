/**
 * The cached snapshot served at `GET /api/state`. Recomputes from the projection, bumps
 * `version` only when the derived content actually changed (§7.2 rule 10), and persists
 * the counter so a restart cannot hand a client a lower version.
 */

import type { StateSnapshot } from '@book/shared';

import type { Db } from '../db/db.ts';
import { listCatalog } from '../db/repo/chapters.ts';
import { getNumber, setMeta } from '../db/repo/meta.ts';
import { type ChapterFact, deriveState, stateFingerprint } from './stateMachine.ts';

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
        chars: entry.chars,
        blocks: entry.blocks,
        writtenAt: entry.writtenAt as string,
        updatedAt: entry.updatedAt as string,
      }));
  }

  snapshot(): StateSnapshot {
    const facts = this.facts();
    const fingerprint = stateFingerprint(facts);
    if (this.cached !== null && fingerprint === this.fingerprint) return this.cached;

    const version = getNumber(this.db, 'state_version', 0) + 1;
    setMeta(this.db, 'state_version', String(version));
    const snapshot = deriveState({ facts, now: this.clock(), version });
    this.cached = snapshot;
    this.fingerprint = fingerprint;
    return snapshot;
  }
}
