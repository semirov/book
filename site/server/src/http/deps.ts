import type { Db } from '../db/db.ts';
import type { StateService } from '../ingest/stateService.ts';

/** What every route may use. Nothing here writes to the manuscript. */
export type RouteDeps = {
  db: Db;
  state: StateService;
  startedAt: number;
  version: string;
  webDist: string;
};
