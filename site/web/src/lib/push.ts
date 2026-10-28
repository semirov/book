/**
 * BOOK-189 — the page's half of Web Push, and the three rules that shape it.
 *
 *   · **consent after an explicit act, never on first paint.** A reader who lands on a chapter and
 *     is asked «разрешить уведомления?» before reading a line has been asked by the browser about
 *     a site they have not yet read; the question is answered «block» and cannot be asked again.
 *     So nothing here runs on mount: the key is read, the row is printed, and `subscribe` — the
 *     one function that calls `requestPermission()` — is reached only from the click handler;
 *   · **iOS installs first.** Safari on iPhone and iPad takes push only from an app added to the
 *     home screen (16.4+), and a page that quietly fails there teaches the reader that the site
 *     is broken. `pushSupport` names that state, and the row says what to do about it;
 *   · **revocation deletes the row.** «выключить» is one tap: the site forgets the endpoint and
 *     the browser drops the subscription, so a reader who said no is not pushed to again. The
 *     local removal happens even when the request failed — the tap is the promise, and the server
 *     drops an endpoint the push service refuses anyway.
 *
 * A subscription is a **capability**: whoever holds the endpoint can post to that device. So the
 * endpoint and the two keys are never logged, never stored and never read back out of the site —
 * they travel one way, in the body of one POST, and every answer is a count. Nothing in this
 * module touches `localStorage`.
 *
 * Everything takes its environment as an argument (`PushEnvironment`, and the `fetch` the caller
 * uses), so the behaviour above is driven by plain objects in `push.test.ts` and no real browser,
 * worker or permission prompt is involved. `browserPushEnv()` is the one function that reads the
 * browser itself, and it answers a fully absent environment where there is no browser at all.
 */

/** What this browser can do about push, before the site says a word about it. */
export type PushSupport = 'ok' | 'unsupported' | 'ios-not-installed';

/** The bits of `PushSubscription` this module reads. Structural, so a test hands in an object. */
export type PushSubscriptionLike = {
  endpoint: string;
  toJSON?: () => { keys?: { p256dh?: string; auth?: string } } | null;
  getKey?: (name: 'p256dh' | 'auth') => ArrayBuffer | null;
  unsubscribe: () => Promise<boolean>;
};

export type PushManagerLike = {
  getSubscription: () => Promise<PushSubscriptionLike | null>;
  subscribe: (options: {
    userVisibleOnly: boolean;
    applicationServerKey: Uint8Array;
  }) => Promise<PushSubscriptionLike>;
};

export type PushRegistrationLike = { pushManager?: PushManagerLike | null };

/** `ServiceWorkerRegistration` for push: what exists now, and what is still installing. */
export type PushServiceWorkerLike = {
  getRegistration: () => Promise<PushRegistrationLike | null>;
  ready: Promise<PushRegistrationLike>;
};

/** `Notification`'s permission surface: the state (a read), and the request (a prompt). */
export type PushNotificationLike = {
  permission: string;
  requestPermission: () => Promise<string>;
};

/** The browser, as this module needs it. `null` fields mean the browser has no such object. */
export type PushEnvironment = {
  serviceWorker: PushServiceWorkerLike | null;
  /** The global `PushManager` constructor — presence only: support, never an instance. */
  pushManager: object | null;
  notification: PushNotificationLike | null;
  /** `navigator.userAgent`; the empty string when this is not a browser. */
  userAgent: string;
  /** `navigator.standalone === true`: iOS Safari's own installed-app flag. */
  standalone: boolean;
  /** `window.matchMedia`; `null` when the page has none. */
  matchMedia: ((query: string) => { matches: boolean }) | null;
};

/** The site's transport: `fetch` in a page, a stub in a test. Never called with a secret in a URL. */
type Fetcher = typeof fetch;

/** Where the four routes live, spelled once. */
const KEY_PATH = '/api/push/key';
const SUBSCRIBE_PATH = '/api/push/subscribe';
const UNSUBSCRIBE_PATH = '/api/push/unsubscribe';

/** A VAPID public key is base64url of 65 bytes — 87 characters. The bounds are generous. */
const KEY_SHAPE = /^[A-Za-z0-9_-]{40,200}$/u;

/** The installed-app query Safari answers on iOS, and the UA names that mean «this is iOS». */
const STANDALONE_QUERY = '(display-mode: standalone)';
const IOS = /iPad|iPhone|iPod/u;

/** No browser at all: a page rendered on the server, a node test, an ancient client. */
function absoluteEnv(): PushEnvironment {
  return {
    serviceWorker: null,
    pushManager: null,
    notification: null,
    userAgent: '',
    standalone: false,
    matchMedia: null,
  };
}

/**
 * The browser's own objects, read once per call. Everything is looked up defensively: a missing
 * global, a `navigator` without a worker registry and a field that is not what it claims to be all
 * answer a `null` (or an empty string) here, instead of throwing on the render path.
 */
export function browserPushEnv(): PushEnvironment {
  // `Window & typeof globalThis`: the constructors below are globals declared with `var`, and a
  // bare `Window` does not carry them in the types.
  const view: (Window & typeof globalThis) | null = typeof window === 'undefined' ? null : window;
  if (view === null) return absoluteEnv();
  const nav = navigator as Navigator & { standalone?: boolean; serviceWorker?: unknown };
  return {
    serviceWorker:
      nav.serviceWorker === undefined
        ? null
        : (nav.serviceWorker as unknown as PushServiceWorkerLike),
    pushManager: typeof view.PushManager === 'function' ? view.PushManager : null,
    notification:
      typeof view.Notification === 'function'
        ? (view.Notification as unknown as PushNotificationLike)
        : null,
    userAgent: typeof nav.userAgent === 'string' ? nav.userAgent : '',
    standalone: nav.standalone === true,
    matchMedia: typeof view.matchMedia === 'function' ? (query) => view.matchMedia(query) : null,
  };
}

/** True when iOS already runs this page from the home screen — the one state that takes push. */
function installed(env: PushEnvironment): boolean {
  if (env.standalone) return true;
  if (env.matchMedia === null) return false;
  try {
    return env.matchMedia(STANDALONE_QUERY).matches === true;
  } catch {
    // A query this browser cannot answer is not an installed app.
    return false;
  }
}

/**
 * What this browser can do, in the order the reader needs it. iOS comes first: on an iPhone the
 * answer is «install the app», and that is true whether or not this Safari is new enough to have
 * `PushManager` — an old one is not a different sentence, it is the same install away from working.
 */
export function pushSupport(env: PushEnvironment): PushSupport {
  if (IOS.test(env.userAgent) && !installed(env)) return 'ios-not-installed';
  if (env.serviceWorker === null || env.pushManager === null || env.notification === null) {
    return 'unsupported';
  }
  return 'ok';
}

/** base64url of these bytes — `atob`'s inverse, and no Node API: this file runs in the page. */
function base64UrlOf(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/**
 * The key as the bytes `applicationServerKey` wants. base64url is not base64: `-`/`_` replace
 * `+`/`/`, the padding is optional, and `atob` refuses both — hence the translation. Invalid input
 * throws, because a caller only ever holds what `readKey` already vetted.
 */
export function decodeKey(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/gu, '+').replace(/_/gu, '/').replace(/=+$/u, '');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** A key the site may hand to `subscribe`: base64url, decodable, and as long as a real one. */
function plausibleKey(value: unknown): string | null {
  if (typeof value !== 'string' || !KEY_SHAPE.test(value)) return null;
  try {
    return decodeKey(value).length >= 32 ? value : null;
  } catch {
    return null;
  }
}

/**
 * The VAPID public key, or `null` when the deployment has push switched off (503), the reader is
 * not allowed to see it (401/403), the answer is not a key, or the network is down. It never
 * throws: a footer row that cannot be printed is not an error the page has to handle.
 */
export async function readKey(fetcher: Fetcher): Promise<string | null> {
  try {
    const answer = await fetcher(KEY_PATH, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (!answer.ok) return null;
    const body = (await answer.json()) as { key?: unknown } | null;
    return body === null || typeof body !== 'object' ? null : plausibleKey(body.key);
  } catch {
    return null;
  }
}

/**
 * The registration that owns this page's push. `wait` is the difference between a reader looking
 * at the row (`getRegistration` only: a worker that is not there yet is `off`) and a reader who
 * tapped (the worker registers on load or the first interaction — `ready` is the promise that it
 * has finished installing, so the subscription is made on a registration that can keep it).
 */
async function registrationOf(
  env: PushEnvironment,
  wait: boolean,
): Promise<PushRegistrationLike | null> {
  if (env.serviceWorker === null) return null;
  const existing = await env.serviceWorker.getRegistration();
  if (existing !== null) return existing;
  if (!wait) return null;
  try {
    return await env.serviceWorker.ready;
  } catch {
    // No worker ever activated: the tap fails, and it can be tapped again.
    return null;
  }
}

/** The subscription this browser holds for this origin, or `null` — never a throw. */
async function subscriptionOf(env: PushEnvironment): Promise<PushSubscriptionLike | null> {
  try {
    const registration = await registrationOf(env, false);
    const manager = registration?.pushManager ?? null;
    return manager === null ? null : await manager.getSubscription();
  } catch {
    return null;
  }
}

/** Does this browser hold a subscription right now: the row's «включены» / «выключены». */
export async function readDeviceState(env: PushEnvironment): Promise<'on' | 'off'> {
  return (await subscriptionOf(env)) === null ? 'off' : 'on';
}

/** One key of the subscription: `toJSON()` when the browser has it, `getKey()` otherwise. */
function keyOf(subscription: PushSubscriptionLike, name: 'p256dh' | 'auth'): string | null {
  const stated = subscription.toJSON?.()?.keys?.[name];
  if (typeof stated === 'string' && stated.length > 0) return stated;
  const raw = subscription.getKey?.(name) ?? null;
  return raw === null ? null : base64UrlOf(new Uint8Array(raw));
}

/** Both keys, or `null` when the browser gave neither shape — a subscription the server refuses. */
function keysOf(subscription: PushSubscriptionLike): { p256dh: string; auth: string } | null {
  const p256dh = keyOf(subscription, 'p256dh');
  const auth = keyOf(subscription, 'auth');
  return p256dh === null || auth === null ? null : { p256dh, auth };
}

/** Drop the browser's subscription; best effort, because the caller has a verdict to return. */
async function forget(subscription: PushSubscriptionLike): Promise<void> {
  try {
    await subscription.unsubscribe();
  } catch {
    // A browser that cannot drop it still holds it; the next tap asks again.
  }
}

/**
 * Ask permission and store the device. Reached only from a click: the prompt is the reader's
 * answer to their own act, and a «block» here is a state the row prints rather than an error.
 *
 * `denied` means the browser said no (or said it before, which is the same answer). `failed` means
 * the browser took the subscription and the site did not: the subscription is dropped again, so
 * the page never says «включены» over a device the site cannot reach, and the row prints its one
 * retry sentence. The key is the site's, never the reader's.
 */
export async function subscribe(
  env: PushEnvironment,
  key: string,
  fetcher: Fetcher = fetch,
): Promise<'ok' | 'denied' | 'failed'> {
  if (env.serviceWorker === null || env.notification === null) return 'failed';
  let made: PushSubscriptionLike | null = null;
  try {
    const permission =
      env.notification.permission === 'granted' ? 'granted' : await env.notification.requestPermission();
    if (permission !== 'granted') return 'denied';

    const registration = await registrationOf(env, true);
    const manager = registration?.pushManager ?? null;
    if (manager === null) return 'failed';

    const subscription = await manager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeKey(key),
    });
    made = subscription;

    const keys = keysOf(subscription);
    if (keys === null) {
      await forget(subscription);
      return 'failed';
    }
    const answer = await fetcher(SUBSCRIBE_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint, keys }),
    });
    if (!answer.ok) {
      await forget(subscription);
      return 'failed';
    }
    return 'ok';
  } catch {
    if (made !== null) await forget(made);
    return 'failed';
  }
}

/**
 * Forget this device: the site first, the browser second, and the browser even when the site
 * failed — the reader's tap is the promise, and a row the server still holds is not a reason to
 * keep a subscription the reader switched off. A browser that refuses to drop it is `failed`, and
 * the row keeps saying «включены», because that is still true of this device.
 */
export async function unsubscribe(
  env: PushEnvironment,
  fetcher: Fetcher = fetch,
): Promise<'ok' | 'failed'> {
  const subscription = await subscriptionOf(env);
  if (subscription === null) return 'ok';
  try {
    await fetcher(UNSUBSCRIBE_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
  } catch {
    // Best effort: the reader said no, and the browser is about to forget the endpoint anyway.
  }
  try {
    return (await subscription.unsubscribe()) ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}
