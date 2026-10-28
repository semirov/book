// @vitest-environment jsdom
/**
 * BOOK-157 — the registration, driven by hand.
 *
 * The worker must never cost a reader a frame, and it must never cost one a *working* worker
 * either: nothing registers before `load` or the first interaction; a rejected registration, and
 * a worker that goes `redundant`, unregister only a registration with nothing to serve — one that
 * is `active` (or `waiting`) is answering the page and stays. The kill switch (`SW_RETIRED`)
 * retires everything once per version: every registration unregistered, every `book-shell-*`
 * cache deleted, no registration at all.
 *
 * The environment is passed in, so each case owns its events, its registrations and its store.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SW_RETIRED, browserEnv, startPwa, type PwaEnv, type RegistrationLike, type WorkerLike } from './pwa.ts';

/** Let the module's own promises run — registration is deliberately not awaited by the caller. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

type FakeWorker = WorkerLike & { fire(): void };

function fakeWorker(state = 'installing'): FakeWorker {
  const listeners: Array<() => void> = [];
  return {
    state,
    addEventListener: (_type, listener) => {
      listeners.push(listener);
    },
    fire: () => {
      for (const listener of listeners) listener();
    },
  };
}

type Harness = {
  env: PwaEnv;
  register: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
  deleted: string[];
  calls: Array<{ script: string; options?: { scope?: string } }>;
  events: EventTarget;
  store: Map<string, string>;
};

function harness(
  options: {
    reject?: boolean;
    /** The worker already answering pages (an update in flight, or a previous install). */
    active?: FakeWorker | null;
    /** The worker this registration is installing right now. */
    installing?: FakeWorker | null;
    /** The worker installed but not yet started (the previous release, while an update waits). */
    waiting?: FakeWorker | null;
    caches?: string[];
    retired?: string;
    storage?: null;
  } = {},
): Harness {
  const events = new EventTarget();
  const calls: Array<{ script: string; options?: { scope?: string } }> = [];
  const store = new Map<string, string>();
  const deleted: string[] = [];
  const cacheNames = options.caches ?? ['book-shell-old', 'unrelated-cache'];

  const unregister = vi.fn(async () => true);
  const registration: RegistrationLike = {
    active: options.active ?? null,
    installing: options.installing ?? null,
    waiting: options.waiting ?? null,
    unregister,
  };

  const register = vi.fn(async (script: string, opts?: { scope?: string }) => {
    calls.push({ script, ...(opts === undefined ? {} : { options: opts }) });
    if (options.reject === true) throw new Error('registration refused');
    return registration;
  });

  const env: PwaEnv = {
    serviceWorker: {
      register,
      getRegistrations: async () => [registration],
    },
    caches: {
      keys: async () => cacheNames,
      delete: async (name: string) => {
        deleted.push(name);
        return true;
      },
    },
    storage:
      options.storage === null
        ? null
        : {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => {
              store.set(key, value);
            },
          },
    events,
    readyState: () => 'loading',
    ...(options.retired === undefined ? {} : { retired: options.retired }),
  };

  return { env, register, unregister, deleted, calls, events, store };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the worker is wanted', () => {
  it('registers nothing until `load`, and then once, at the root scope', async () => {
    const h = harness();
    startPwa(h.env);

    await flush();
    expect(h.register).not.toHaveBeenCalled();

    h.events.dispatchEvent(new Event('load'));
    await flush();
    expect(h.calls).toEqual([{ script: '/sw.js', options: { scope: '/' } }]);
  });

  it('registers on the first interaction instead, and only once', async () => {
    const h = harness();
    startPwa(h.env);

    h.events.dispatchEvent(new Event('pointerdown'));
    h.events.dispatchEvent(new Event('keydown'));
    h.events.dispatchEvent(new Event('touchstart'));
    h.events.dispatchEvent(new Event('load'));
    await flush();

    expect(h.register).toHaveBeenCalledTimes(1);
  });

  it('registers at once when the page has already loaded', async () => {
    const h = harness();
    startPwa({ ...h.env, readyState: () => 'complete' });

    await flush();
    expect(h.register).toHaveBeenCalledTimes(1);
  });

  it('is inert where there is no service worker: a browser without one, an insecure origin', () => {
    // jsdom's navigator has no `serviceWorker`, which is exactly that state.
    expect(browserEnv()).toBeNull();
    expect(() => startPwa(null)).not.toThrow();
  });

  it('builds its environment from the browser when there is a worker', () => {
    const container = { register: async () => ({}) as RegistrationLike, getRegistrations: async () => [] };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
    try {
      const env = browserEnv();
      expect(env).not.toBeNull();
      expect(env?.serviceWorker).toBe(container);
      // The page's own events, its own storage, its own readiness.
      expect(env?.events).toBe(window);
      expect(env?.storage).toBe(window.localStorage);
      expect(['loading', 'interactive', 'complete']).toContain(env?.readyState?.());
    } finally {
      Reflect.deleteProperty(navigator, 'serviceWorker');
    }
  });

  it('leaves no corpse when the registration is refused and nothing was serving', async () => {
    const h = harness({ reject: true });
    startPwa(h.env);
    h.events.dispatchEvent(new Event('load'));

    await flush();
    expect(h.register).toHaveBeenCalledTimes(1);
    expect(h.unregister).toHaveBeenCalledTimes(1);
  });

  it('keeps a registration that is answering the page when this attempt is refused', async () => {
    // The network is down at this instant, or the shell was fetched mid-deploy: the registration
    // a previous load installed is still active, so a refusal now must not take it away.
    const h = harness({ reject: true, active: fakeWorker('activated') });
    startPwa(h.env);
    h.events.dispatchEvent(new Event('load'));

    await flush();
    expect(h.register).toHaveBeenCalledTimes(1);
    expect(h.unregister).not.toHaveBeenCalled();
  });

  it('keeps a registration that has a worker waiting', async () => {
    // A `waiting` worker is a worker that can answer on the next load: still not a corpse.
    const h = harness({ reject: true, waiting: fakeWorker('installed') });
    startPwa(h.env);
    h.events.dispatchEvent(new Event('load'));

    await flush();
    expect(h.unregister).not.toHaveBeenCalled();
  });

  it('unregisters a first install whose worker goes redundant: there is nothing behind it', async () => {
    const worker = fakeWorker('installing');
    const h = harness({ installing: worker });
    startPwa(h.env);
    h.events.dispatchEvent(new Event('load'));
    await flush();
    expect(h.unregister).not.toHaveBeenCalled();

    worker.state = 'redundant';
    worker.fire();
    await flush();
    expect(h.unregister).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed update: the worker already answering pages is not the corpse', async () => {
    // A new build's `cache.addAll` 404s in a half-published release: the new worker goes
    // redundant, and the registration still has the previous, working worker.
    const active = fakeWorker('activated');
    const update = fakeWorker('installing');
    const h = harness({ active, installing: update });
    startPwa(h.env);
    h.events.dispatchEvent(new Event('load'));
    await flush();

    update.state = 'redundant';
    update.fire();
    await flush();
    expect(h.unregister).not.toHaveBeenCalled();
  });

  it('does not unregister a worker that merely activates', async () => {
    const worker = fakeWorker('installing');
    const h = harness({ installing: worker });
    startPwa(h.env);
    h.events.dispatchEvent(new Event('load'));
    await flush();

    worker.state = 'activated';
    worker.fire();
    await flush();
    expect(h.unregister).not.toHaveBeenCalled();
  });
});

describe('the kill switch (SW_RETIRED)', () => {
  it('is empty by default: the worker is wanted', () => {
    expect(SW_RETIRED).toBe('');
  });

  it('unregisters every registration, deletes only the shell caches, and never registers', async () => {
    const h = harness({ retired: '2026-10-28' });
    startPwa(h.env);
    await flush();

    expect(h.register).not.toHaveBeenCalled();
    expect(h.unregister).toHaveBeenCalledTimes(1);
    expect(h.deleted).toEqual(['book-shell-old']);
    expect(h.store.get('book.sw.retired')).toBe('2026-10-28');
  });

  it('does the work once per version, and not at all for a version already retired', async () => {
    const h = harness({ retired: '2026-10-28' });
    startPwa(h.env);
    await flush();
    expect(h.unregister).toHaveBeenCalledTimes(1);

    // The same shell loading again: the record is the answer, no second unregister.
    startPwa(h.env);
    await flush();
    expect(h.unregister).toHaveBeenCalledTimes(1);
    expect(h.deleted).toEqual(['book-shell-old']);

    // A new version retires again.
    startPwa({ ...h.env, retired: '2026-11-01' });
    await flush();
    expect(h.unregister).toHaveBeenCalledTimes(2);
  });

  it('retires a browser whose storage is unreadable or absent, and one without caches', async () => {
    // A private-mode browser throws on `localStorage` and on `getItem`; neither is a reason to
    // keep running a worker the operator retired.
    const noStorage = harness({ retired: '2026-10-28', storage: null });
    startPwa(noStorage.env);
    await flush();
    expect(noStorage.unregister).toHaveBeenCalledTimes(1);
    expect(noStorage.deleted).toEqual(['book-shell-old']);

    const refusing = harness({ retired: '2026-10-28' });
    startPwa({
      ...refusing.env,
      storage: {
        getItem: () => {
          throw new Error('access denied');
        },
        setItem: () => {
          throw new Error('access denied');
        },
      },
      caches: null,
    });
    await flush();
    expect(refusing.unregister).toHaveBeenCalledTimes(1);

    // A CacheStorage that cannot even list its keys is not a reason to throw at the page.
    const brokenCaches = harness({ retired: '2026-10-28' });
    startPwa({
      ...brokenCaches.env,
      caches: {
        keys: async () => {
          throw new Error('cache storage is gone');
        },
        delete: async () => true,
      },
    });
    await flush();
    expect(brokenCaches.unregister).toHaveBeenCalledTimes(1);
  });

  it('survives a registration list it cannot read', async () => {
    const h = harness();
    startPwa({
      ...h.env,
      serviceWorker: {
        register: async () => {
          throw new Error('refused');
        },
        getRegistrations: async () => {
          throw new Error('no list');
        },
      },
    });
    h.events.dispatchEvent(new Event('load'));
    await flush();
    // Nothing to unregister and nothing thrown: a dead worker is not a dead page.
    expect(h.unregister).not.toHaveBeenCalled();
  });
});
