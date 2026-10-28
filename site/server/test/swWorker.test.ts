/**
 * BOOK-157 — the generated `sw.js`, *run*: install, activate and fetch through a fake worker
 * scope, with a fake CacheStorage and a fake network.
 *
 * The text checks in `pwa.test.ts` can pass while the worker does nothing useful — the first
 * version of the decision table compared `request.url` (absolute, in a worker) against `/assets/`
 * and would have answered every hashed file with a network miss. So this file drives the real
 * generated source and asserts what each class of request gets:
 *
 *   document   network when it answers, the constant (with `data-offline="1"`) when it does not;
 *   passthrough the book, the transport, `sw.js` itself: the worker does not answer at all;
 *   asset      the stored copy, and no network read while it is there;
 *   unhashed   the network, and the stored copy only as the offline fallback.
 *
 * A new release never takes an open page over: nothing here calls into `clients` but `claim`.
 */

import { Script } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { cacheNameOf, offlineDocument, precacheList, swSource } from '../../scripts/lib/sw.mjs';

const ORIGIN = 'https://book.semirov.dev';
const CACHE = cacheNameOf({ commit: 'abc1234', stamp: '27.10 20:52', builtAt: '2026-10-27T17:52:00.000Z' });
const PRECACHE = precacheList([
  'assets/index-Bx12_3de.js',
  'assets/index-Bx12_3de.css',
  'fonts/ptserif-400-cyrillic.woff2',
  'icons/icon-192.png',
  'theme.js',
  'index.html',
  'sw.js',
]);

type FetchEvent = { request: { url: string; mode: string; method: string }; respondWith?: (answer: Promise<Response>) => void };

type Harness = {
  install(): Promise<void>;
  activate(): Promise<void>;
  fetch(path: string, mode?: string): Promise<Response | null>;
  networkCalls: string[];
  deleted: string[];
  stored(): string[];
  seed(name: string, path: string): void;
  claims: () => number;
  failNetwork: boolean;
};

/** The worker, with `self`, `caches` and `fetch` replaced by plain objects. */
function runWorker(): Harness {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const stores = new Map<string, Map<string, Response>>();
  const deleted: string[] = [];
  const networkCalls: string[] = [];
  let claims = 0;
  let failNetwork = false;

  const pathOf = (request: unknown): string => {
    const raw = typeof request === 'string' ? request : (request as { url: string }).url;
    return new URL(raw, ORIGIN).pathname;
  };
  const store = (name: string): Map<string, Response> => {
    let found = stores.get(name);
    if (found === undefined) {
      found = new Map();
      stores.set(name, found);
    }
    return found;
  };

  const caches = {
    async open(name: string) {
      const entries = store(name);
      return {
        async addAll(paths: string[]) {
          for (const path of paths) {
            if (failNetwork) throw new Error('offline');
            entries.set(pathOf(path), new Response(`stored:${path}`));
          }
        },
        async match(request: unknown) {
          return entries.get(pathOf(request));
        },
        async put(request: unknown, response: Response) {
          entries.set(pathOf(request), response);
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      deleted.push(name);
      return stores.delete(name);
    },
  };

  const scope = {
    clients: {
      async claim() {
        claims += 1;
      },
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      const found = listeners.get(type) ?? [];
      found.push(listener);
      listeners.set(type, found);
    },
  };

  const origin = ORIGIN;
  const fetchImpl = async (request: unknown): Promise<Response> => {
    const path = pathOf(request);
    networkCalls.push(path);
    if (failNetwork) throw new TypeError('network down');
    return new Response(`network:${path}`, { headers: { 'content-type': 'text/plain' } });
  };

  const source = swSource({
    cacheName: CACHE,
    precache: PRECACHE,
    offline: offlineDocument({ js: '/assets/index-Bx12_3de.js', css: '/assets/index-Bx12_3de.css' }),
  });
  new Script(source).runInNewContext({ self: scope, caches, fetch: fetchImpl, Response, URL, String, Promise, JSON, Error });

  const dispatch = async (type: string, event: Record<string, unknown>): Promise<void> => {
    const pending: Array<Promise<unknown>> = [];
    for (const listener of listeners.get(type) ?? []) {
      listener({
        ...event,
        waitUntil: (promise: Promise<unknown>) => {
          pending.push(promise);
        },
      });
    }
    await Promise.all(pending);
  };

  return {
    install: () => dispatch('install', {}),
    activate: () => dispatch('activate', {}),
    async fetch(path, mode = 'no-cors') {
      let answer: Promise<Response> | null = null;
      const event: FetchEvent = {
        request: { url: `${origin}${path}`, mode, method: 'GET' },
        respondWith: (promise) => {
          answer = promise;
        },
      };
      await dispatch('fetch', event);
      return answer === null ? null : await answer;
    },
    networkCalls,
    deleted,
    stored: () => [...store(CACHE).keys()].sort(),
    seed: (name, path) => {
      store(name).set(path, new Response(`seeded:${path}`));
    },
    claims: () => claims,
    get failNetwork() {
      return failNetwork;
    },
    set failNetwork(value: boolean) {
      failNetwork = value;
    },
  };
}

describe('the generated worker, run against a fake scope', () => {
  it('installs exactly the precache list into its own cache', async () => {
    const worker = runWorker();
    await worker.install();
    expect(worker.stored()).toEqual([...PRECACHE].sort());
    expect(worker.stored()).not.toContain('/index.html');
    expect(worker.stored()).not.toContain('/sw.js');
    expect(worker.claims()).toBe(0);
  });

  it('deletes every other shell cache on activate, keeps what is not ours, and claims the clients', async () => {
    const worker = runWorker();
    await worker.install();
    // A previous release's cache, and one that belongs to something else on this origin.
    worker.seed('book-shell-old-1', '/theme.js');
    worker.seed('unrelated-cache', '/x');
    await worker.activate();
    expect(worker.deleted).toEqual(['book-shell-old-1']);
    // This release's own cache is untouched, and the page is claimed (BOOK-157: claiming is the
    // only thing a new worker does to open pages — it never takes the page over mid-sentence).
    expect(worker.stored()).toEqual([...PRECACHE].sort());
    expect(worker.claims()).toBe(1);
  });

  it('answers a navigation from the network while the network is up', async () => {
    const worker = runWorker();
    await worker.install();
    const answer = await worker.fetch('/', 'navigate');
    expect(answer?.status).toBe(200);
    expect(await answer?.text()).toBe('network:/');
    expect(worker.networkCalls).toEqual(['/']);
  });

  it('answers a navigation with the constant when the network is down, and never with a cached page', async () => {
    const worker = runWorker();
    await worker.install();
    worker.failNetwork = true;
    const answer = await worker.fetch('/ch-8', 'navigate');
    const body = (await answer?.text()) ?? '';
    expect(answer?.status).toBe(200);
    expect(body.startsWith('<!doctype html>')).toBe(true);
    expect(body).toContain('data-offline="1"');
    // The sentence is the document's own content, not a class-dependent shell: it is what a
    // reader sees when the release's hashed `/assets/*` are gone from the HTTP cache.
    expect(body).toContain(`<div id="root">`);
    expect(body).toContain('<p>сети нет — главы читаются с сервера, офлайн их нет</p>');
    // The document the worker sends may not be stored by the browser either.
    expect(answer?.headers.get('cache-control')).toBe('no-store');
    // Nothing was read from the cache: the offline document is the constant, not a page.
    expect(body).not.toContain('stored:');
  });

  it('leaves the book, the transport and its own script alone', async () => {
    const worker = runWorker();
    await worker.install();
    for (const path of ['/api/state', '/api/chapters/1?at=5', '/healthz', '/book.fb2', '/sw.js', '/manifest.webmanifest']) {
      // `null` means `respondWith` was never called: the browser makes the request itself.
      expect(await worker.fetch(path), path).toBeNull();
    }
    expect(worker.networkCalls).toEqual([]);
  });

  it('serves a hashed asset from the cache, with no network read at all', async () => {
    const worker = runWorker();
    await worker.install();
    const answer = await worker.fetch('/assets/index-Bx12_3de.js');
    expect(await answer?.text()).toBe('stored:/assets/index-Bx12_3de.js');
    expect(worker.networkCalls).toEqual([]);

    // A name this release does not hold: the network, and nothing stored.
    const miss = await worker.fetch('/assets/other-zz.js');
    expect(await miss?.text()).toBe('network:/assets/other-zz.js');
    expect(worker.stored()).not.toContain('/assets/other-zz.js');
  });

  it('fetches an unhashed shell file from the network first, and falls back to the store offline', async () => {
    const worker = runWorker();
    await worker.install();
    const fresh = await worker.fetch('/theme.js');
    expect(await fresh?.text()).toBe('network:/theme.js');

    worker.failNetwork = true;
    const stored = await worker.fetch('/theme.js');
    expect(await stored?.text()).toBe('stored:/theme.js');

    // A font and an icon take the same path; one this release never stored fails, it is not faked.
    expect(await (await worker.fetch('/fonts/ptserif-400-cyrillic.woff2'))?.text()).toBe(
      'stored:/fonts/ptserif-400-cyrillic.woff2',
    );
    await expect(worker.fetch('/icons/gone.png')).rejects.toThrow(/network down/u);
  });
});
