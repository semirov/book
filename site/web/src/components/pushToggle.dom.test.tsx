// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PUSH_DENIED_LINE, PUSH_FAILED_LINE, PUSH_IOS_LINE, PushToggle } from './PushToggle.tsx';
import {
  browserPushEnv,
  pushSupport,
  type PushEnvironment,
  type PushRegistrationLike,
  type PushSubscriptionLike,
} from '../lib/push.ts';

/**
 * BOOK-189 — the row, mounted.
 *
 * The copy and the placement are the colophon's; this file drives what a browser does: the row is
 * absent wherever the answer could not be true (signed out, push off, no push objects), the
 * permission prompt is opened by the click and by nothing else, one tap turns push on and one tap
 * turns it off, and a state the page cannot grant back (a browser's own denial, iOS without the
 * app) prints a sentence and no button.
 *
 * The environment is injected, as in `push.test.ts`: jsdom has no push objects and no prompt. The
 * `fetch` is stubbed the way `colophonLogout.dom.test.tsx` stubs it.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** 65 bytes of a VAPID key, base64url — the shape the route answers. */
const KEY = 'B'.repeat(87);
const DESKTOP =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';

type Tracked = PushSubscriptionLike & { unsubscribe: ReturnType<typeof vi.fn> };

function subscription(overrides: Partial<Tracked> = {}): Tracked {
  return {
    endpoint: 'https://push.example/abc',
    toJSON: () => ({ keys: { p256dh: 'p256dh-key', auth: 'auth-key' } }),
    unsubscribe: vi.fn(async () => true),
    ...overrides,
  };
}

/**
 * The environment a browser hands the row, with the permission spy kept aside: whether the prompt
 * was opened is a fact about the row, not about the environment.
 */
function pushEnv(
  options: {
    held?: PushSubscriptionLike | null;
    permission?: string;
    /** What the browser answers when the click asks. */
    ask?: string;
    userAgent?: string;
    standalone?: boolean;
    subscribe?: () => Promise<PushSubscriptionLike>;
  } = {},
): { env: PushEnvironment; asked: ReturnType<typeof vi.fn> } {
  const permission = options.permission ?? 'default';
  const asked = vi.fn(async () => options.ask ?? (permission === 'denied' ? 'denied' : 'granted'));
  const manager = {
    getSubscription: async () => options.held ?? null,
    subscribe:
      options.subscribe ??
      (async () => {
        throw new Error('the browser was not asked to subscribe');
      }),
  };
  const registration: PushRegistrationLike = { pushManager: manager };
  return {
    env: {
      serviceWorker: {
        getRegistration: async () => registration,
        ready: Promise.resolve(registration),
      },
      pushManager: {},
      notification: { permission, requestPermission: asked },
      userAgent: options.userAgent ?? DESKTOP,
      standalone: options.standalone ?? false,
      matchMedia: null,
    },
    asked,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  container = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

/** Let the reads' promises and React's updates land: a macrotask drains them all. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mount(viewer: { signedIn: boolean; displayName: string | null }, env: PushEnvironment): void {
  void act(() => {
    root?.render(<PushToggle viewer={viewer} env={env} />);
  });
}

const signedIn = { signedIn: true, displayName: 'Филипп' };
const guest = { signedIn: false, displayName: null };

/** The row's text, as a reader sees it: runs of whitespace go. */
function rowText(): string {
  return (container?.querySelector('.push-row')?.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

function button(): HTMLButtonElement | null {
  return container?.querySelector<HTMLButtonElement>('.push-toggle') ?? null;
}

/** A `fetch` that answers the key route first and then whatever the test says. */
function stubFetch(
  answer: (path: string) => Response | Promise<Response> = () => Response.json({ key: KEY }),
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => answer(String(input)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('where the notifications row exists (BOOK-189)', () => {
  it('prints nothing for a signed-out reader, and asks the site nothing', async () => {
    const fetchMock = stubFetch();
    const { env, asked } = pushEnv();
    mount(guest, env);
    await flush();

    expect(container?.innerHTML).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
    // The one rule that must survive every refactor: no prompt before the reader's own act.
    expect(asked).not.toHaveBeenCalled();
  });

  it('prints nothing when the deployment has push switched off', async () => {
    stubFetch(() => Response.json({ code: 'PUSH_OFF' }, { status: 503 }));
    mount(signedIn, pushEnv().env);
    await flush();

    expect(container?.innerHTML).toBe('');
    expect(button()).toBeNull();
  });

  it('prints nothing in a browser without the push objects, and reads no key there', async () => {
    const fetchMock = stubFetch();
    const { env } = pushEnv();
    mount(signedIn, { ...env, serviceWorker: null, pushManager: null, notification: null });
    await flush();

    expect(container?.innerHTML).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prints nothing in jsdom\'s own empty window either, when no environment is injected', async () => {
    // The production path: the row reads the live browser. jsdom has no push objects, so the row
    // is absent — and, being absent, it asks the site for no key.
    const fetchMock = stubFetch();
    void act(() => {
      root?.render(<PushToggle viewer={signedIn} />);
    });
    await flush();

    expect(container?.innerHTML).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the key once per mount, and asks for the permission only on the click', async () => {
    const fetchMock = stubFetch();
    const { env, asked } = pushEnv();
    mount(signedIn, env);
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/push/key');
    expect(rowText()).toBe('уведомления: выключены · включить');
    expect(asked).not.toHaveBeenCalled();
  });
});

describe('turning push on and off, one tap (BOOK-189)', () => {
  it('subscribes on the click, and prints «включены · выключить»', async () => {
    const pushed = subscription();
    const { env, asked } = pushEnv({ held: null, subscribe: async () => pushed });
    const fetchMock = stubFetch((path) =>
      path === '/api/push/key' ? Response.json({ key: KEY }) : Response.json({ devices: 1 }),
    );
    mount(signedIn, env);
    await flush();

    expect(rowText()).toBe('уведомления: выключены · включить');
    // Nothing about the device may reach the console: the endpoint is a capability, not a detail.
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    await act(async () => button()?.click());
    await flush();

    // The prompt is the reader's own act, asked once, and the POST carries the subscription.
    expect(asked).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [path, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(path).toBe('/api/push/subscribe');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
    });

    expect(rowText()).toBe('уведомления: включены · выключить');
    // Nothing about the device is kept by the page: no storage, no log.
    expect(window.localStorage.length).toBe(0);
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
    for (const spy of logs) spy.mockRestore();
  });

  it('unsubscribes on the click, and prints «выключены · включить»', async () => {
    const pushed = subscription();
    const { env, asked } = pushEnv({ held: pushed });
    const fetchMock = stubFetch((path) =>
      path === '/api/push/key' ? Response.json({ key: KEY }) : Response.json({ devices: 0 }),
    );
    mount(signedIn, env);
    await flush();

    expect(rowText()).toBe('уведомления: включены · выключить');
    await act(async () => button()?.click());
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [path, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(path).toBe('/api/push/unsubscribe');
    expect(JSON.parse(String(init.body))).toEqual({ endpoint: 'https://push.example/abc' });
    expect(pushed.unsubscribe).toHaveBeenCalledTimes(1);
    expect(rowText()).toBe('уведомления: выключены · включить');
    // A revocation asks nothing: the browser's permission is not spent on saying no.
    expect(asked).not.toHaveBeenCalled();
  });

  it('locks the button while a request is in flight, and starts nothing twice', async () => {
    const pushed = subscription();
    let settle: (value: PushSubscriptionLike) => void = () => undefined;
    const slow = new Promise<PushSubscriptionLike>((resolve) => {
      settle = resolve;
    });
    const { env, asked } = pushEnv({ subscribe: () => slow });
    const fetchMock = stubFetch((path) =>
      path === '/api/push/key' ? Response.json({ key: KEY }) : Response.json({ devices: 1 }),
    );
    mount(signedIn, env);
    await flush();

    await act(async () => button()?.click());
    // The subscription is being made: the word is still there, the control is not.
    expect(button()?.disabled).toBe(true);
    await act(async () => button()?.click());
    expect(asked).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle(pushed);
      await slow;
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rowText()).toBe('уведомления: включены · выключить');
  });
});

describe('the states no tap can change (BOOK-189)', () => {
  it('states a browser denial, and offers no button', async () => {
    stubFetch();
    mount(signedIn, pushEnv({ permission: 'denied' }).env);
    await flush();

    expect(rowText()).toBe(PUSH_DENIED_LINE);
    expect(PUSH_DENIED_LINE).toBe('уведомления: выключены в браузере');
    expect(button()).toBeNull();
  });

  it('says that iOS needs the installed app, and offers no button', async () => {
    stubFetch();
    mount(signedIn, pushEnv({ userAgent: IOS }).env);
    await flush();

    expect(rowText()).toBe(PUSH_IOS_LINE);
    expect(PUSH_IOS_LINE).toBe('уведомления — только из установленного приложения');
    expect(button()).toBeNull();
  });
});

describe('a failed tap (BOOK-189)', () => {
  it('keeps the state, prints its own line, and starts the next attempt clean', async () => {
    const { env } = pushEnv({ subscribe: async () => subscription() });
    let attempts = 0;
    const fetchMock = stubFetch((path) => {
      if (path === '/api/push/key') return Response.json({ key: KEY });
      attempts += 1;
      return Response.json({ code: 'PUSH_OFF' }, { status: 503 });
    });
    mount(signedIn, env);
    await flush();

    await act(async () => button()?.click());
    await flush();

    // The setting did not move, and the row says the attempt failed in the same line.
    expect(attempts).toBe(1);
    expect(rowText()).toBe(`уведомления: выключены · включить · ${PUSH_FAILED_LINE}`);
    expect(PUSH_FAILED_LINE).toBe('не удалось — попробуйте ещё');
    expect(button()?.disabled).toBe(false);

    // A retry starts clean: the old sentence goes with the new attempt, before the answer lands.
    let release: () => void = () => undefined;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/push/key') return Response.json({ key: KEY });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return Response.json({ devices: 1 });
    });
    await act(async () => button()?.click());
    expect(rowText()).toBe('уведомления: выключены · включить');
    expect(button()?.disabled).toBe(true);
    await act(async () => release());
    await flush();
    expect(rowText()).toBe('уведомления: включены · выключить');
  });

  it('turns the row into the browser-denial sentence when the permission is refused', async () => {
    // The browser's own state is «not decided»; the click is what asks, and the answer is no.
    const { env, asked } = pushEnv({ permission: 'default', ask: 'denied' });
    const fetchMock = stubFetch();
    mount(signedIn, env);
    await flush();

    expect(rowText()).toBe('уведомления: выключены · включить');
    await act(async () => button()?.click());
    await flush();

    // A tap cannot undo the browser's answer, so the button goes with it.
    expect(asked).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rowText()).toBe(PUSH_DENIED_LINE);
    expect(button()).toBeNull();
  });
});

describe('the browser\'s own objects (BOOK-189)', () => {
  it('reads them into an environment the row can use', () => {
    const pushed = subscription();
    const registration: PushRegistrationLike = {
      pushManager: { getSubscription: async () => null, subscribe: async () => pushed },
    };
    vi.stubGlobal('navigator', {
      userAgent: IOS,
      serviceWorker: {
        getRegistration: async () => registration,
        ready: Promise.resolve(registration),
      },
    });
    vi.stubGlobal(
      'PushManager',
      function PushManager() {
        return undefined;
      },
    );
    // `Notification` is a constructor with statics, not a plain object: the check reads the shape.
    vi.stubGlobal(
      'Notification',
      Object.assign(function Notification() {
        return undefined;
      }, { permission: 'default', requestPermission: async () => 'default' }),
    );
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(display-mode: standalone)' }));

    const env = browserPushEnv();
    expect(env.notification?.permission).toBe('default');
    expect(env.userAgent).toContain('iPhone');
    expect(env.standalone).toBe(false);
    expect(env.matchMedia?.('(display-mode: standalone)').matches).toBe(true);
    // Installed as an app: this iPhone may subscribe.
    expect(pushSupport(env)).toBe('ok');

    // The same page in a tab: the row says to install instead.
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(pushSupport(browserPushEnv())).toBe('ios-not-installed');

    // A browser that carries neither a worker registry nor a UA string: both are absences, not
    // exceptions on the render path.
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('Notification', undefined);
    const bare = browserPushEnv();
    expect(bare.serviceWorker).toBeNull();
    expect(bare.userAgent).toBe('');
    expect(bare.notification).toBeNull();
    expect(pushSupport(bare)).toBe('unsupported');
  });
});
