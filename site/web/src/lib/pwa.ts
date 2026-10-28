/**
 * BOOK-157 — the installable shell's service worker, registered when it cannot cost a reader a
 * frame.
 *
 * The worker exists for one thing: a navigation with no network answers a written sentence
 * instead of the browser's error page, and the shell's own files are there for it to paint with.
 * It stores no prose (BOOK-109) — `/api/*`, `/healthz`, `/book.fb2` and every HTML document stay
 * network-only in `sw.js`, and the offline document is a constant in the worker.
 *
 * Three rules shape this module:
 *
 *   · **inert until the page is idle.** Nothing is fetched, parsed or registered while the reader
 *     is arriving: registration waits for `load` or for the first interaction (`pointerdown`,
 *     `keydown`, `touchstart`), whichever comes first, once. `main.tsx` calls this after
 *     `render`, never awaits it, and a failure here stays invisible to the page;
 *   · **a broken worker leaves no corpse — and only a corpse.** A rejected `register`, and a
 *     worker that goes `redundant` with nothing behind it, end with the registrations that have
 *     no worker unregistered. One that is `active` (or `waiting`) is answering pages right now,
 *     so it stays: a refusal at this instant is not a reason to take a working offline shell
 *     away from a reader, and a failed *update* must not kill the version that works;
 *   · **a version bump is the off switch.** `SW_RETIRED` is empty by default; set it to a version
 *     string (e.g. `'2026-10-28'`) to retire the worker from every browser that loads this shell:
 *     the page unregisters every registration, deletes every `book-shell-*` cache, records the
 *     version once (so the work is not repeated on every load) and does not register at all.
 */

/** The kill switch. Empty means "the worker is wanted"; a version string retires it once. */
export const SW_RETIRED = '';

/** Where the retired version is remembered: `localStorage`, one key, no PII. */
const RETIRED_KEY = 'book.sw.retired';

/** The cache family `scripts/lib/sw.mjs` owns — the only keys the kill switch deletes. */
const SHELL_CACHE_PREFIX = 'book-shell-';

/** The scope the worker governs: the whole book, so an installed app opens any chapter. */
const SCOPE = '/';

export type WorkerLike = {
  state: string;
  addEventListener(type: 'statechange', listener: () => void): void;
};

export type RegistrationLike = {
  active: WorkerLike | null;
  installing: WorkerLike | null;
  waiting: WorkerLike | null;
  unregister(): Promise<boolean>;
};

export type PwaEnv = {
  serviceWorker: {
    register(script: string, options?: { scope?: string }): Promise<RegistrationLike>;
    getRegistrations(): Promise<RegistrationLike[]>;
  };
  caches?: { keys(): Promise<string[]>; delete(name: string): Promise<boolean> } | null;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  events: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  /** `document.readyState` — a page whose `load` already fired registers at once. */
  readyState?: () => string;
  /** `SW_RETIRED` unless a test pins it. */
  retired?: string;
};

/** The interactions that mean the reader has arrived, and a worker may cost one request. */
const FIRST_INTERACTION = ['pointerdown', 'keydown', 'touchstart'] as const;

/**
 * The browser's own objects, or `null` when there is no service worker to register: an old
 * browser, an insecure origin, a jsdom test. Nothing else in this module is reached then.
 */
export function browserEnv(): PwaEnv | null {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  return {
    serviceWorker: navigator.serviceWorker as unknown as PwaEnv['serviceWorker'],
    caches: 'caches' in globalThis ? (globalThis.caches as PwaEnv['caches']) : null,
    storage: safeStorage(),
    events: window,
    readyState: () => document.readyState,
  };
}

function safeStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // A browser with storage disabled throws on the property itself.
    return null;
  }
}

/** True when the registration has a worker that can answer: one that works, or one waiting. */
function hasWorker(registration: RegistrationLike): boolean {
  return registration.active !== null || registration.waiting !== null;
}

/**
 * Unregister every registration: the state a working page is in when the operator retires the
 * worker (the kill switch). Nothing else uses this — a failed `register` must not touch a
 * registration that a previous load installed and that is serving the page right now.
 */
async function unregisterAll(env: PwaEnv): Promise<void> {
  try {
    const registrations = await env.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      try {
        await registration.unregister();
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* nothing to unregister */
  }
}

/**
 * Unregister only the registrations with nothing to serve — a broken worker leaves no corpse, and
 * a working one is not a corpse. A rejected `register` is often a moment (the network is down,
 * the shell was fetched during a deploy); the registration a previous load installed answers the
 * page anyway, so it stays.
 */
async function unregisterDead(env: PwaEnv): Promise<void> {
  try {
    const registrations = await env.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      if (hasWorker(registration)) continue;
      try {
        await registration.unregister();
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* nothing to unregister */
  }
}

/** Delete the shell's caches and nothing else: the book's other storage is not ours. */
async function deleteShellCaches(env: PwaEnv): Promise<void> {
  const caches = env.caches ?? null;
  if (caches === null) return;
  try {
    for (const name of await caches.keys()) {
      if (!name.startsWith(SHELL_CACHE_PREFIX)) continue;
      try {
        await caches.delete(name);
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* a browser without CacheStorage has nothing to delete */
  }
}

/** The kill switch: once per version, and never a registration. */
async function retire(env: PwaEnv, version: string): Promise<void> {
  const storage = env.storage ?? null;
  if (storage !== null) {
    try {
      if (storage.getItem(RETIRED_KEY) === version) return;
    } catch {
      /* unreadable storage: do the work, the version is a record, not a lock */
    }
  }
  await unregisterAll(env);
  await deleteShellCaches(env);
  if (storage !== null) {
    try {
      storage.setItem(RETIRED_KEY, version);
    } catch {
      /* the record is best effort */
    }
  }
}

/**
 * A registration that becomes `redundant` is a worker no page can use — but only the *registration*
 * decides whether that leaves a corpse. A first install that failed has nothing behind it, so it
 * is dropped; an update that failed has the previous worker still answering every page, and
 * unregistering the whole registration there would take a working worker away over a failed
 * download (e.g. one precache file that 404s in a half-published release).
 */
function watch(registration: RegistrationLike): void {
  for (const worker of [registration.installing, registration.waiting, registration.active]) {
    if (worker === null) continue;
    worker.addEventListener('statechange', () => {
      if (worker.state !== 'redundant') return;
      if (registration.active !== null) return;
      void registration.unregister().catch(() => undefined);
    });
  }
}

async function keep(env: PwaEnv): Promise<void> {
  try {
    const registration = await env.serviceWorker.register('/sw.js', { scope: SCOPE });
    watch(registration);
  } catch {
    // No worker at all is the honest end of a failed registration — for the registrations that
    // have no worker. One that is active (or waiting) is answering the page and stays: a refusal
    // now is a moment, and the reader does not pay for it with a working offline shell.
    await unregisterDead(env);
  }
}

/**
 * Register the offline shell, or retire it — never awaited on the render path, never blocking.
 */
export function startPwa(env: PwaEnv | null = browserEnv()): void {
  if (env === null) return;

  const retired = env.retired ?? SW_RETIRED;
  if (retired.length > 0) {
    void retire(env, retired);
    return;
  }

  let started = false;
  const start = (): void => {
    if (started) return;
    started = true;
    env.events.removeEventListener('load', start);
    for (const name of FIRST_INTERACTION) env.events.removeEventListener(name, start);
    void keep(env);
  };

  // A shell whose `load` has already fired (a late module, a warm cache) would otherwise wait
  // for an interaction that may never come.
  if ((env.readyState?.() ?? 'loading') === 'complete') {
    start();
    return;
  }
  env.events.addEventListener('load', start, { once: true });
  for (const name of FIRST_INTERACTION) env.events.addEventListener(name, start, { once: true });
}
