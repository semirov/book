/**
 * BOOK-189 — the page's half of push, driven by hand.
 *
 * Every case below is a plain object: no browser, no worker, no permission prompt. What the tests
 * hold is the part that is easy to get wrong and expensive in the real world — that the prompt is
 * opened by the click and never by the mount, that a refused browser stops the row instead of
 * retrying it, and that the two sides never disagree: a device the site did not store is a device
 * the browser drops again, and a tap on «выключить» removes the browser's subscription even when
 * the site could not be told.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  browserPushEnv,
  decodeKey,
  pushSupport,
  readDeviceState,
  readKey,
  subscribe,
  unsubscribe,
  type PushEnvironment,
  type PushRegistrationLike,
  type PushSubscriptionLike,
} from './push.ts';

/** base64url of these bytes, the way a VAPID key arrives: no padding, `-` and `_`. */
function base64url(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}

/** 65 bytes of a public key, in the alphabet push services use. */
const KEY = base64url(Array.from({ length: 65 }, (_, index) => 253 - index));
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** A `Notification` stand-in: the state it holds, and the answer the click's request gives. */
const notification = (permission = 'default', answer = 'granted') => ({
  permission,
  requestPermission: vi.fn(async () => answer),
});

/** A subscription whose `unsubscribe` is a spy: the local half of the two-sided promise. */
type Tracked = PushSubscriptionLike & { unsubscribe: ReturnType<typeof vi.fn> };

/** The environment a page starts from: no push objects at all. */
function env(overrides: Partial<PushEnvironment> = {}): PushEnvironment {
  return {
    serviceWorker: null,
    pushManager: null,
    notification: null,
    userAgent: DESKTOP,
    standalone: false,
    matchMedia: null,
    ...overrides,
  };
}

function subscription(overrides: Partial<Tracked> = {}): Tracked {
  return {
    endpoint: 'https://push.example/abc',
    toJSON: () => ({ keys: { p256dh: 'p256dh-key', auth: 'auth-key' } }),
    unsubscribe: vi.fn(async () => true),
    ...overrides,
  };
}

function manager(subscriptionValue: PushSubscriptionLike | null) {
  return {
    getSubscription: vi.fn(async () => subscriptionValue),
    subscribe: vi.fn(async () => subscriptionValue as PushSubscriptionLike),
  };
}

function serviceWorker(registration: PushRegistrationLike | null, ready?: PushRegistrationLike) {
  return {
    getRegistration: vi.fn(async () => registration),
    ready: ready === undefined ? new Promise<PushRegistrationLike>(() => undefined) : Promise.resolve(ready),
  };
}

/** A `fetch` that records what it was asked and answers with the handler's Response. */
function fetcherOf(handler: (path: string, init?: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, init });
    return handler(path, init);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

describe('what this browser can do (BOOK-189)', () => {
  it('is unsupported when any of the three objects is missing', () => {
    const full = {
      serviceWorker: serviceWorker(null),
      pushManager: {},
      notification: notification(),
    };
    expect(pushSupport(env(full))).toBe('ok');
    expect(pushSupport(env())).toBe('unsupported');
    expect(pushSupport(env({ ...full, serviceWorker: null }))).toBe('unsupported');
    expect(pushSupport(env({ ...full, pushManager: null }))).toBe('unsupported');
    expect(pushSupport(env({ ...full, notification: null }))).toBe('unsupported');
  });

  it('answers «install the app first» on iOS, and «ok» once the page is installed', () => {
    const full = {
      serviceWorker: serviceWorker(null),
      pushManager: {},
      notification: notification(),
      userAgent: IOS,
    };
    // Safari in a tab cannot subscribe: the reader is told to install, not left with a dead row.
    expect(pushSupport(env(full))).toBe('ios-not-installed');
    expect(pushSupport(env({ ...full, userAgent: IOS.replace('iPhone', 'iPad') }))).toBe('ios-not-installed');
    // `navigator.standalone` is Safari's own flag for an app added to the home screen.
    expect(pushSupport(env({ ...full, standalone: true }))).toBe('ok');
    // …and the display-mode query is the same fact from the other side.
    const standalone = env({ ...full, matchMedia: () => ({ matches: true }) });
    expect(pushSupport(standalone)).toBe('ok');
    expect(
      pushSupport(env({ ...full, matchMedia: () => ({ matches: false }) })),
    ).toBe('ios-not-installed');
    // A query that throws is not an installed app.
    expect(
      pushSupport(
        env({
          ...full,
          matchMedia: () => {
            throw new Error('no display-mode here');
          },
        }),
      ),
    ).toBe('ios-not-installed');
    // The same objects outside iOS are simply ready.
    expect(pushSupport(env({ ...full, userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile' }))).toBe('ok');
  });

  it('reads the browser itself, and answers an absent environment where there is no browser', () => {
    // The node test environment has no `window`: the module must not throw at import or at call.
    const absent = browserPushEnv();
    expect(absent.serviceWorker).toBeNull();
    expect(absent.pushManager).toBeNull();
    expect(absent.notification).toBeNull();
    expect(absent.matchMedia).toBeNull();
    expect(pushSupport(absent)).toBe('unsupported');
  });
});

describe('the key (BOOK-189)', () => {
  it('reads a plausible key from the route', async () => {
    const { fetcher, calls } = fetcherOf(() => json({ key: KEY }));
    expect(await readKey(fetcher)).toBe(KEY);
    expect(calls[0]?.path).toBe('/api/push/key');
    // The same session cookie the rest of the page uses; the key itself is public.
    expect(calls[0]?.init?.credentials).toBe('same-origin');
  });

  it('answers null when push is switched off, the answer is not a key, or the network is down', async () => {
    expect(await readKey(fetcherOf(() => json({ code: 'PUSH_OFF' }, 503)).fetcher)).toBeNull();
    expect(await readKey(fetcherOf(() => json({ key: 'short' })).fetcher)).toBeNull();
    expect(await readKey(fetcherOf(() => json({ key: 42 })).fetcher)).toBeNull();
    // A key of the right alphabet and length that decodes to fewer than 32 bytes is not a key.
    expect(await readKey(fetcherOf(() => json({ key: 'B'.repeat(40) })).fetcher)).toBeNull();
    // A key in the right alphabet and length that is not base64 at all: `atob` refuses it.
    expect(await readKey(fetcherOf(() => json({ key: 'A'.repeat(41) })).fetcher)).toBeNull();
    expect(await readKey(fetcherOf(() => json({})).fetcher)).toBeNull();
    expect(await readKey(fetcherOf(() => json(null)).fetcher)).toBeNull();
    // A 200 whose body is not JSON is not a key either.
    expect(await readKey(fetcherOf(() => new Response('nope')).fetcher)).toBeNull();
    const down = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    expect(await readKey(down)).toBeNull();
  });

  it('decodes base64url to the bytes `applicationServerKey` wants', () => {
    // `-_8` is `+/8` in base64: the two characters atob refuses are the two that arrive.
    expect(Array.from(decodeKey('-_8'))).toEqual([0xfb, 0xff]);
    const bytes = Array.from({ length: 65 }, (_, index) => 253 - index);
    expect(Array.from(decodeKey(KEY))).toEqual(bytes);
    // And the site's own key shape round-trips through both directions.
    expect(base64url(bytes)).toBe(KEY);
  });
});

describe('the device this browser holds (BOOK-189)', () => {
  it('is off with no worker, no registration, no manager or no subscription', async () => {
    expect(await readDeviceState(env())).toBe('off');
    expect(
      await readDeviceState(
        env({ serviceWorker: serviceWorker(null), pushManager: {}, notification: notification() }),
      ),
    ).toBe('off');
    expect(
      await readDeviceState(
        env({ serviceWorker: serviceWorker({}), pushManager: {}, notification: notification() }),
      ),
    ).toBe('off');
    expect(
      await readDeviceState(
        env({
          serviceWorker: serviceWorker({ pushManager: manager(null) }),
          pushManager: {},
          notification: notification(),
        }),
      ),
    ).toBe('off');
  });

  it('is on when the browser holds a subscription, and off when the registration throws', async () => {
    expect(
      await readDeviceState(
        env({
          serviceWorker: serviceWorker({ pushManager: manager(subscription()) }),
          pushManager: {},
          notification: notification(),
        }),
      ),
    ).toBe('on');
    const broken = {
      getRegistration: async () => {
        throw new Error('the worker registry is gone');
      },
      ready: new Promise<PushRegistrationLike>(() => undefined),
    };
    expect(await readDeviceState(env({ serviceWorker: broken }))).toBe('off');
  });
});

describe('turning it on (BOOK-189)', () => {
  const on = (overrides: Partial<PushEnvironment> = {}, pushed: PushSubscriptionLike = subscription()) => {
    const opened = manager(pushed);
    return {
      opened,
      env: env({
        serviceWorker: serviceWorker({ pushManager: opened }),
        pushManager: {},
        notification: notification('default'),
        ...overrides,
      }),
    };
  };

  it('asks the browser only when it is called, and never when it is refused', async () => {
    const { opened, env: ready } = on({ notification: notification('denied', 'denied') });
    const { fetcher, calls } = fetcherOf(() => json({ devices: 1 }));

    // Nothing has been asked yet: the caller decides when the question is spent.
    expect(ready.notification?.requestPermission).not.toHaveBeenCalled();
    expect(await subscribe(ready, KEY, fetcher)).toBe('denied');

    // The prompt was opened once, and a refusal is the end of it: no subscription, no POST.
    expect(ready.notification?.requestPermission).toHaveBeenCalledTimes(1);
    expect(opened.getSubscription).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('subscribes with the decoded key and posts the browser\'s own subscription', async () => {
    const { env: ready } = on();
    const { fetcher, calls } = fetcherOf(() => json({ devices: 1 }));

    expect(await subscribe(ready, KEY, fetcher)).toBe('ok');
    const init = calls[0]?.init;
    expect(calls[0]?.path).toBe('/api/push/subscribe');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    // The exact body the route parses: the endpoint and the two keys, nothing else.
    expect(JSON.parse(String(init?.body))).toEqual({
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
    });
  });

  it('waits for a worker that is still installing, and gives up when none ever activates', async () => {
    const pushed = subscription();
    const opened = manager(pushed);
    const installing = {
      getRegistration: vi.fn(async () => null),
      ready: Promise.resolve({ pushManager: opened }),
    };
    const { fetcher } = fetcherOf(() => json({ devices: 1 }));
    expect(
      await subscribe(env({ serviceWorker: installing, pushManager: {}, notification: notification('granted') }), KEY, fetcher),
    ).toBe('ok');
    expect(opened.subscribe).toHaveBeenCalledTimes(1);

    const never = {
      getRegistration: vi.fn(async () => null),
      ready: Promise.reject(new Error('nothing activated')),
    };
    expect(
      await subscribe(env({ serviceWorker: never, pushManager: {}, notification: notification('granted') }), KEY, fetcher),
    ).toBe('failed');
  });

  it('fails — and drops the browser\'s subscription — when the site did not store it', async () => {
    const pushed = subscription();
    const { env: ready } = on({}, pushed);
    const { fetcher } = fetcherOf(() => json({ code: 'PUSH_OFF' }, 503));

    expect(await subscribe(ready, KEY, fetcher)).toBe('failed');
    // The two sides must not disagree: a device the site cannot reach is not kept in the browser.
    expect(pushed.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('fails the same way when the request never lands, and when the browser cannot drop it', async () => {
    const reject = subscription({ unsubscribe: vi.fn(async () => true) });
    const { env: first } = on({}, reject);
    const down = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    expect(await subscribe(first, KEY, down)).toBe('failed');
    expect(reject.unsubscribe).toHaveBeenCalledTimes(1);

    // A browser whose `unsubscribe()` rejects still gets the verdict, not an exception.
    const stubborn = subscription({
      unsubscribe: vi.fn(async () => {
        throw new Error('refused');
      }),
    });
    const { env: second } = on({}, stubborn);
    const answer = fetcherOf(() => json({ code: 'SERVER' }, 500));
    expect(await subscribe(second, KEY, answer.fetcher)).toBe('failed');
    expect(stubborn.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('refuses a subscription whose keys cannot be read, and an environment without push objects', async () => {
    const bare = subscription({ toJSON: () => ({ keys: {} }) });
    const { env: ready } = on({}, bare);
    const { fetcher, calls } = fetcherOf(() => json({ devices: 1 }));
    expect(await subscribe(ready, KEY, fetcher)).toBe('failed');
    // Nothing was posted, and the half-made subscription is gone again.
    expect(calls).toEqual([]);
    expect(bare.unsubscribe).toHaveBeenCalledTimes(1);

    // No `Notification` and no worker: the click fails rather than throwing out of the handler.
    expect(await subscribe(env(), KEY, fetcher)).toBe('failed');
  });

  it('reads the keys from `getKey()` when the browser has no `toJSON()`', async () => {
    const bytes = new TextEncoder().encode('p256dh-material');
    const raw = subscription({
      toJSON: undefined,
      getKey: (name) => (name === 'p256dh' ? bytes.buffer.slice(0) : new Uint8Array([1, 2, 3, 4]).buffer),
    });
    const { env: ready } = on({}, raw);
    const { fetcher, calls } = fetcherOf(() => json({ devices: 1 }));
    expect(await subscribe(ready, KEY, fetcher)).toBe('ok');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      endpoint: 'https://push.example/abc',
      keys: {
        p256dh: base64url(Array.from(bytes)),
        auth: base64url([1, 2, 3, 4]),
      },
    });
  });
});

describe('turning it off (BOOK-189)', () => {
  it('is already off when the browser holds nothing: no request, no failure', async () => {
    const { fetcher, calls } = fetcherOf(() => json({ devices: 0 }));
    expect(await unsubscribe(env(), fetcher)).toBe('ok');
    expect(calls).toEqual([]);
  });

  it('tells the site which device to forget, then drops the browser\'s subscription', async () => {
    const pushed = subscription();
    const { fetcher, calls } = fetcherOf(() => json({ devices: 0 }));
    const ready = env({
      serviceWorker: serviceWorker({ pushManager: manager(pushed) }),
      pushManager: {},
      notification: notification('granted'),
    });

    expect(await unsubscribe(ready, fetcher)).toBe('ok');
    expect(calls[0]?.path).toBe('/api/push/unsubscribe');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ endpoint: 'https://push.example/abc' });
    expect(pushed.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('drops the browser\'s subscription even when the site could not be told', async () => {
    const pushed = subscription();
    const ready = env({
      serviceWorker: serviceWorker({ pushManager: manager(pushed) }),
      pushManager: {},
      notification: notification('granted'),
    });
    const down = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;

    // The reader's one tap is the promise: the browser forgets the endpoint either way.
    expect(await unsubscribe(ready, down)).toBe('ok');
    expect(pushed.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('is failed only when the browser keeps the subscription', async () => {
    const kept = subscription({ unsubscribe: vi.fn(async () => false) });
    const ready = env({ serviceWorker: serviceWorker({ pushManager: manager(kept) }) });
    expect(await unsubscribe(ready, fetcherOf(() => json({ devices: 0 })).fetcher)).toBe('failed');

    const throwing = subscription({
      unsubscribe: vi.fn(async () => {
        throw new Error('refused');
      }),
    });
    expect(
      await unsubscribe(
        env({ serviceWorker: serviceWorker({ pushManager: manager(throwing) }) }),
        fetcherOf(() => json({ devices: 0 })).fetcher,
      ),
    ).toBe('failed');
  });
});
