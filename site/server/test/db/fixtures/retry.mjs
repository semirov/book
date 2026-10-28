/**
 * BOOK-175 — a retry discipline a writer process may adopt, with the accounting these tests need.
 *
 * `busy_timeout` makes SQLite wait for the write lock *inside* the driver; what it does not do is
 * decide what happens when that wait is over. Production today does not retry there: the engine
 * maps `SQLITE_BUSY` to `DB_BUSY` / 503 (`server/src/engine/control.ts`), and the writer lane
 * retries once at the transport (`server/src/writer/client.ts`). What this loop adds is the
 * measurement — an attempt's wall time **is** the lock wait that happened, so `maxWaitMs` is
 * evidence, not a guess — and the bound: an `SQLITE_BUSY` that outlives the budget is a real
 * refusal (a stuck writer), and it propagates to the caller instead of being retried forever.
 */

/**
 * A synchronous sleep via `Atomics.wait`. A fixture's ordering must not depend on timers, and in
 * a child process the event loop only runs when we let it.
 */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `SQLITE_BUSY`, `SQLITE_BUSY_SNAPSHOT`, `SQLITE_BUSY_TIMEOUT`: every one is a lock, not a fault. */
export function isLockWait(error) {
  return typeof error?.code === 'string' && error.code.startsWith('SQLITE_BUSY');
}

export function withRetry(run, { retries = 10, budgetMs = 20_000, backoffMs = 15, onBusy = null } = {}) {
  const startedAt = Date.now();
  const stats = { attempts: 0, retries: 0, maxWaitMs: 0, waitedMs: 0 };

  for (;;) {
    const attemptStart = Date.now();
    try {
      const value = run();
      const wait = Date.now() - attemptStart;
      stats.attempts += 1;
      stats.maxWaitMs = Math.max(stats.maxWaitMs, wait);
      return { value, ...stats };
    } catch (error) {
      const wait = Date.now() - attemptStart;
      stats.attempts += 1;
      stats.maxWaitMs = Math.max(stats.maxWaitMs, wait);
      if (!isLockWait(error)) throw error;

      stats.retries += 1;
      stats.waitedMs += wait;
      if (onBusy !== null) onBusy({ retry: stats.retries, waitMs: wait, code: error.code });

      if (stats.retries > retries) throw error;
      if (Date.now() - startedAt + backoffMs > budgetMs) throw error;
      sleepSync(backoffMs);
    }
  }
}
