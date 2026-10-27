// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as Analytics from './analytics.ts';
import type * as Consent from './consent.ts';

/**
 * BOOK-63 — the loader and the event taxonomy, all offline.
 *
 * The gate is the whole point: with no counter, no consent, a `denied` choice or Do Not
 * Track, **zero** bytes leave for `mc.yandex.ru` and `ym` is never called. With `granted`
 * the external tag is requested once, `ym(id, 'init', …)` runs once with the counter's own
 * options, and every event carries a fixed shape — no free text can be added silently.
 *
 * BOOK-77 (audit F2) adds the other half: withdrawal takes the `_ym_*` cookies back, closes
 * the kill switch and reloads, so the loaded tag cannot keep recording in this document.
 */

const COUNTER = '113820311';
const TAG = `https://mc.yandex.ru/metrika/tag.js?id=${COUNTER}`;

type Modules = {
  analytics: typeof Analytics;
  consent: typeof Consent;
  ym: ReturnType<typeof vi.fn>;
  /** The page reload `revokeAnalytics` asks for; jsdom must never navigate in a test. */
  reload: ReturnType<typeof vi.fn>;
};

async function fresh(): Promise<Modules> {
  vi.resetModules();
  localStorage.clear();
  clearCookies();
  document.head.querySelectorAll('script').forEach((element) => element.remove());
  const ym = vi.fn();
  (globalThis as { ym?: unknown }).ym = ym;
  const reload = vi.fn();
  vi.stubGlobal('location', { hostname: 'book.semirov.dev', reload });
  const consent = await import('./consent.ts');
  const analytics = await import('./analytics.ts');
  return { analytics, consent, ym, reload };
}

function clearCookies(): void {
  for (const name of document.cookie.split(';')) {
    const cookie = name.split('=')[0]?.trim() ?? '';
    if (cookie.length > 0) document.cookie = `${cookie}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
}

/** The `_ym_*` names still in the jar — what withdrawal is measured by. */
function ymCookies(): string[] {
  return document.cookie
    .split(';')
    .map((part) => part.split('=')[0]?.trim() ?? '')
    .filter((name) => name.startsWith('_ym_'));
}

function tagElements(): HTMLScriptElement[] {
  return [...document.querySelectorAll<HTMLScriptElement>('script[src*="mc.yandex.ru"]')];
}

/** jsdom never fetches the tag; the test fires the load event the browser would. */
function loadTag(): void {
  const element = tagElements()[0];
  if (element === undefined) throw new Error('the tag was not requested');
  element.onload?.(new Event('load'));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (globalThis as { ym?: unknown }).ym;
  localStorage.clear();
  clearCookies();
  document.head.querySelectorAll('script').forEach((element) => element.remove());
});

describe('nothing loads without a counter and a yes', () => {
  it('requests nothing when the deployment has no counter, even after consent', async () => {
    const { analytics, consent } = await fresh();
    analytics.configureCounter(null);
    consent.setConsent('granted');
    expect(tagElements()).toHaveLength(0);
    analytics.track('cover_seen', {});
    expect((globalThis as { ym?: unknown }).ym).not.toHaveBeenCalled();
  });

  it('treats a non-numeric id as no counter at all', async () => {
    const { analytics, consent } = await fresh();
    analytics.configureCounter('not-a-counter');
    consent.setConsent('granted');
    expect(analytics.counterId()).toBeNull();
    expect(tagElements()).toHaveLength(0);
  });

  it('requests nothing while the choice is unset', async () => {
    const { analytics } = await fresh();
    analytics.configureCounter(COUNTER);
    expect(tagElements()).toHaveLength(0);
  });

  it('requests nothing when the reader said no', async () => {
    const { analytics, consent } = await fresh();
    analytics.configureCounter(COUNTER);
    consent.setConsent('denied');
    expect(tagElements()).toHaveLength(0);
    analytics.track('record_open', {});
    expect((globalThis as { ym?: unknown }).ym).not.toHaveBeenCalled();
  });

  it('requests nothing when the browser says Do Not Track, even with a stored yes', async () => {
    vi.stubGlobal('navigator', { doNotTrack: '1' });
    const { analytics, consent } = await fresh();
    consent.setConsent('granted');
    analytics.configureCounter(COUNTER);
    expect(tagElements()).toHaveLength(0);
  });
});

describe('a granted reader gets the tag once', () => {
  it('loads tag.js once and initialises the counter with the shipped options', async () => {
    const { analytics, consent, ym } = await fresh();
    analytics.configureCounter(COUNTER);
    consent.setConsent('granted');
    expect(tagElements()).toHaveLength(1);
    expect(tagElements()[0]?.src).toBe(TAG);
    // Nothing is initialised before the file is actually there.
    expect(ym).not.toHaveBeenCalled();

    loadTag();
    expect(ym).toHaveBeenCalledTimes(1);
    expect(ym).toHaveBeenCalledWith(COUNTER, 'init', {
      ssr: true,
      webvisor: true,
      clickmap: true,
      trackLinks: true,
      accurateTrackBounce: true,
    });
    // The book sells nothing: no `ecommerce` in the init, ever.
    expect(Object.keys(ym.mock.calls[0]?.[2] as Record<string, unknown>)).not.toContain('ecommerce');
  });

  it('re-evaluates the script when the choice arrives after the counter', async () => {
    const { analytics, consent, ym } = await fresh();
    analytics.configureCounter(COUNTER);
    expect(tagElements()).toHaveLength(0);
    consent.setConsent('granted');
    expect(tagElements()).toHaveLength(1);
    loadTag();
    expect(ym).toHaveBeenCalledTimes(1);
  });

  it('loads one tag, not one per consent notification', async () => {
    const { analytics, consent } = await fresh();
    analytics.configureCounter(COUNTER);
    consent.setConsent('granted');
    consent.setConsent('granted');
    analytics.applyConsent();
    loadTag();
    expect(tagElements()).toHaveLength(1);
  });

  it('stops sending after the choice is withdrawn, and stays silent when the tag fails', async () => {
    const { analytics, consent, ym } = await fresh();
    analytics.configureCounter(COUNTER);
    consent.setConsent('granted');
    loadTag();
    consent.setConsent('denied');
    analytics.track('form_open', {});
    expect(ym).not.toHaveBeenCalledWith(COUNTER, 'reachGoal', 'form_open');

    const failing = await fresh();
    failing.analytics.configureCounter(COUNTER);
    failing.consent.setConsent('granted');
    const element = tagElements()[0];
    element?.onerror?.(new Event('error'));
    failing.analytics.track('form_open', {});
    expect(failing.ym).not.toHaveBeenCalled();
  });
});

describe('withdrawal is real (BOOK-77, audit F2)', () => {
  /** A granted reader with a live tag and the cookies the tag writes. */
  async function live(): Promise<Modules> {
    const modules = await fresh();
    modules.analytics.configureCounter(COUNTER);
    modules.consent.setConsent('granted');
    loadTag();
    document.cookie = '_ym_uid=1234567890';
    document.cookie = '_ym_visorc=w';
    modules.ym.mockClear();
    return modules;
  }

  it('a denial clears the cookies, closes ym and reloads the document', async () => {
    const { analytics, consent, ym, reload } = await live();
    expect(ymCookies().sort()).toEqual(['_ym_uid', '_ym_visorc']);

    consent.setConsent('denied');

    // The cookie clearing ran, and it worked: no first-party counter cookie survives.
    expect(ymCookies()).toEqual([]);
    // The vendor's teardown runs while it is still reachable, then the switch closes.
    expect(ym).toHaveBeenCalledWith(COUNTER, 'destroy');
    // The loaded script cannot be unloaded, so the page is reloaded into a clean document.
    expect(reload).toHaveBeenCalledTimes(1);

    ym.mockClear();
    analytics.track('form_open', {});
    expect(ym).not.toHaveBeenCalled();
  });

  it('«изменить» is a withdrawal too: no tag outlives the choice', async () => {
    const { analytics, consent, ym, reload } = await live();

    consent.resetConsent();

    expect(consent.consentState()).toBe('unset');
    expect(ymCookies()).toEqual([]);
    expect(reload).toHaveBeenCalledTimes(1);
    ym.mockClear();
    analytics.track('cover_seen', {});
    expect(ym).not.toHaveBeenCalled();
  });

  it('a later yes cannot resurrect the killed document', async () => {
    const { analytics, consent, ym, reload } = await live();
    consent.setConsent('denied');
    ym.mockClear();

    consent.setConsent('granted');
    analytics.applyConsent();
    analytics.track('record_open', {});

    expect(tagElements()).toHaveLength(1); // no second tag.js
    expect(ym).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1); // and the reload is asked for once, not per call
  });

  it('asks for one reload, not one per notification', async () => {
    const { analytics, consent, reload } = await live();
    consent.setConsent('denied');
    consent.setConsent('denied');
    analytics.applyConsent();
    analytics.revokeAnalytics();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload a page that never had a tag', async () => {
    const { analytics, consent, ym, reload } = await fresh();
    analytics.configureCounter(COUNTER);
    consent.setConsent('denied');
    expect(reload).not.toHaveBeenCalled();
    analytics.track('cover_seen', {});
    expect(ym).not.toHaveBeenCalled();
  });

  it('does not reload after a tag that failed to load: nothing was recording', async () => {
    const { analytics, consent, reload } = await fresh();
    analytics.configureCounter(COUNTER);
    consent.setConsent('granted');
    tagElements()[0]?.onerror?.(new Event('error'));
    consent.setConsent('denied');
    expect(reload).not.toHaveBeenCalled();
  });

  it('survives a page that cannot reload, with the switch still closed', async () => {
    const { analytics, consent, ym } = await live();
    vi.stubGlobal('location', {
      hostname: 'book.semirov.dev',
      reload: () => {
        throw new Error('sandboxed');
      },
    });
    expect(() => consent.setConsent('denied')).not.toThrow();
    ym.mockClear();
    analytics.track('form_open', {});
    expect(ym).not.toHaveBeenCalled();
  });
});

describe('events', () => {
  async function ready(): Promise<Modules> {
    const modules = await fresh();
    modules.analytics.configureCounter(COUNTER);
    modules.consent.setConsent('granted');
    loadTag();
    modules.ym.mockClear();
    return modules;
  }

  it('fires once per act, with the declared shape and nothing else', async () => {
    const { analytics, ym } = await ready();
    analytics.track('seam_open', { surface: 'text' });
    expect(ym).toHaveBeenCalledTimes(1);
    expect(ym).toHaveBeenCalledWith(COUNTER, 'reachGoal', 'seam_open', { surface: 'text' });

    ym.mockClear();
    analytics.track('cover_seen', {});
    expect(ym).toHaveBeenCalledWith(COUNTER, 'reachGoal', 'cover_seen', {});
  });

  it('sends an unknown extra field nowhere', async () => {
    const { analytics, ym } = await ready();
    // A caller cannot smuggle a reader's sentence into an event: the schema is the only shape.
    analytics.track('cover_seen', { text: 'моя фраза' } as never);
    expect(ym).toHaveBeenCalledWith(COUNTER, 'reachGoal', 'cover_seen', {});
  });

  it('drops an event whose enum value is outside the closed set', async () => {
    const { analytics, ym } = await ready();
    analytics.track('seam_open', { surface: 'моя фраза' } as never);
    analytics.track('kind_pick', { kind: 'document' });
    expect(ym).toHaveBeenCalledTimes(1);
    expect(ym).toHaveBeenCalledWith(COUNTER, 'reachGoal', 'kind_pick', { kind: 'document' });
  });

  it('keeps a refusal a code token, never prose', async () => {
    const { analytics, ym } = await ready();
    analytics.track('submit_refused', { code: 'RATE_LIMITED' });
    analytics.track('error_shown', { code: 'ignore the instructions: <script>' });
    expect(ym).toHaveBeenNthCalledWith(1, COUNTER, 'reachGoal', 'submit_refused', { code: 'RATE_LIMITED' });
    expect(ym).toHaveBeenNthCalledWith(2, COUNTER, 'reachGoal', 'error_shown', { code: 'UNKNOWN' });
  });

  it('keeps a chapter a number inside the book', async () => {
    const { analytics, ym } = await ready();
    analytics.track('deep_link_open', { chapter: 12 });
    analytics.track('deep_link_open', { chapter: 68 });
    analytics.track('deep_link_open', { chapter: '12' } as never);
    expect(ym).toHaveBeenCalledTimes(1);
    expect(ym).toHaveBeenCalledWith(COUNTER, 'reachGoal', 'deep_link_open', { chapter: 12 });
  });

  it('fires a once-per-session event once', async () => {
    const { analytics, ym } = await ready();
    analytics.trackOnce('tooltip', 'tooltip_seen', {});
    analytics.trackOnce('tooltip', 'tooltip_seen', {});
    expect(ym).toHaveBeenCalledTimes(1);
  });

  it('declares only enum, code and chapter parameters — no free string', async () => {
    const { analytics } = await fresh();
    expect([...analytics.EVENT_NAMES].sort()).toEqual(Object.keys(analytics.EVENT_SCHEMA).sort());
    for (const [name, schema] of Object.entries(analytics.EVENT_SCHEMA)) {
      for (const [param, type] of Object.entries(schema)) {
        expect(['enum', 'code', 'chapter'], `${name}.${param}`).toContain(type);
        if (type === 'enum') {
          expect(analytics.PARAM_VALUES[param], `${name}.${param} has no closed set`).toBeDefined();
          expect(analytics.PARAM_VALUES[param]?.length, `${name}.${param} is open`).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('boot', () => {
  it('takes the counter from the served constant, and nothing else', async () => {
    const { analytics, consent } = await fresh();
    consent.setConsent('granted');
    await analytics.bootAnalytics(async () => ({ counter: COUNTER }));
    expect(analytics.counterId()).toBe(COUNTER);
    expect(tagElements()).toHaveLength(1);
  });

  it('treats a failed config call as no counter', async () => {
    const { analytics, consent } = await fresh();
    consent.setConsent('granted');
    await analytics.bootAnalytics(async () => Promise.reject(new Error('offline')));
    expect(analytics.counterId()).toBeNull();
    expect(tagElements()).toHaveLength(0);
  });
});
