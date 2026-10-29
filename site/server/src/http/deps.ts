import type { AuthorsCountDto, BookCostDto, Imprint, QueueDto, ServerEventType } from '@book/shared';

import type { CaptchaVerifier } from '../captcha/verify.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import type { Fb2Renderer } from '../fb2/serialize.ts';
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
  /** BOOK-109: the build this process is, read once at boot (`build.ts`), reported by `/healthz`. */
  commit: string;
  webDist: string;
  imprint: Imprint;
  /** Live watcher counters; absent in REST-only tests, which then report the last scan. */
  watcher?: WatcherStatus;
  /** Optional cache seam for `/api/queue`; by default it is read from the shared database. */
  engineQueue?: () => QueueDto;
  /**
   * BOOK-60: serializer seam for `/book.fb2`; by default the hand-written FB2 renderer.
   * A counting wrapper here is how the tests prove a `304` and a repeat build nothing.
   */
  fb2?: { render: Fb2Renderer };
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
  /**
   * BOOK-145: the admin trigger opens one pass on demand. Injected by a test; in production the
   * route asks the engine's loopback API, which is the only writer of a step.
   */
  enginePass?: (chapter: number) => Promise<{ stepId: string; chapter: number }>;
  /**
   * BOOK-137 (M1): called after a completed launch reset. The engine bridge holds in-memory
   * cursors over ids the wipe restarted, so it has to be re-primed, or the live chronicle goes
   * silent. Absent in tests and in a boot that has no bridge.
   */
  onBookReset?: () => void;
  /** The title page's byline count, with a monotonic marker shared by every surface. */
  authorsCount: () => AuthorsCountDto;
  /** §9/BOOK-114: the book's outlay — one whole-book aggregate, memoised by book state. */
  bookCost: () => BookCostDto;
  /**
   * BOOK-189: the VAPID public key, or `null` when push is off (no readable key file). Read once
   * at boot by `push/vapid.ts`; the route answers `503 PUSH_OFF` on `null`, never a guess.
   */
  pushKey: string | null;
};
