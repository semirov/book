/**
 * The bridge as the site builds it (BOOK-220).
 *
 * `EngineBridge` narrates rows into frames, and `chapter:applied` is the one frame whose payload
 * is not in the row: its patch and span come from the two revision snapshots under
 * `<dataDir>/versions/…` (`applied.ts`). A bridge built without the data dir reads a path that
 * does not exist, so every write is published as `patchTruncated: true, span: null, patch: []`
 * — the page prints nothing, and no test could see it: `index.ts` is outside coverage.
 *
 * This factory is the only place the site builds a bridge. What the bridge needs from the
 * deployment — the data dir the snapshots live under and the lane's day bound — is read from
 * the same `config` here, so a call site cannot forget one field of the family.
 */

import type { StateSnapshot } from '@book/shared';

import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import { EngineBridge, type BridgeEmit } from './bridge.ts';

export type EngineBridgeWiring = {
  /** The deployment's own values: where the snapshots are, and how many passes a day holds. */
  config: Pick<Config, 'dataDir' | 'writerMaxPasses'>;
  db: Db;
  emit: BridgeEmit;
  /** The snapshot published after a frame; omitted in tests that only inspect events. */
  snapshot?: () => StateSnapshot;
};

export function createEngineBridge(options: EngineBridgeWiring): EngineBridge {
  return new EngineBridge({
    db: options.db,
    emit: options.emit,
    snapshot: options.snapshot,
    // The revision snapshots' root: without it `chapter:applied` carries no patch and no print.
    dataDir: options.config.dataDir,
    maxPasses: options.config.writerMaxPasses,
  });
}
