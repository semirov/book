import type { AuthorsCountDto, Imprint, QueueDto, ServerEventType } from '@book/shared';

import type { CaptchaVerifier } from '../captcha/verify.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import type { StateService } from '../ingest/stateService.ts';
import type { WatcherStatus } from '../ingest/watcher.ts';
import type { SessionStore } from '../identity/session.ts';
import type { OAuthFetch } from '../identity/yandex.ts';
import type { RateLimiter } from '../rate/limiter.ts';

/** What every route may use. Nothing here writes to the manuscript. */
export type RouteDeps = {
  db: Db;
  state: StateService;
  config: Config;
  startedAt: number;
  version: string;
  webDist: string;
  imprint: Imprint;
  /** Live watcher counters; absent in REST-only tests, which then report the last scan. */
  watcher?: WatcherStatus;
  /** Optional cache seam for `/api/queue`; by default it is read from the shared database. */
  engineQueue?: () => QueueDto;
  /** §14: one limiter for every surface, so budgets cannot drift apart. */
  limiter: RateLimiter;
  /** §12.8: injected as a stub in tests; the production verifier fails closed. */
  captcha: CaptchaVerifier;
  /** §9: the only credential; identity is never taken from a body. */
  sessions: SessionStore;
  /** HMAC key for the OAuth state (a file-mount secret in deployment). */
  sessionSecret: string;
  /** §14: raw IPs are hashed before they are stored. */
  ipHash: (ipKey: string) => string;
  now: () => Date;
  /** §10: the route that creates a fact broadcasts it. */
  emit?: (type: Exclude<ServerEventType, 'hello' | 'state:snapshot'>, data: unknown) => void;
  /** Test seam for the Yandex token/profile calls. */
  oauthFetch?: OAuthFetch;
  /** Empty means the admin surface does not exist (404), never an open panel (§17). */
  adminToken: string;
  /** The title page's byline count, with a monotonic marker shared by every surface. */
  authorsCount: () => AuthorsCountDto;
};
