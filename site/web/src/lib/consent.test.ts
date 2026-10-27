// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * BOOK-63 — the consent gate's own state (comment #3619: an active, informed, separate
 * choice). The record is versioned, dated, and never invented: nothing stored or unreadable
 * means `unset`, and Do Not Track is a refusal even when a `granted` record exists.
 */

const KEY = 'book.consent.metrika';
const VERSION = '2026-10-27.1';

/** A fresh module graph per case: the record is memoised per page, like the real one. */
async function fresh(): Promise<typeof import('./consent.ts')> {
  vi.resetModules();
  return import('./consent.ts');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('the consent record', () => {
  it('is unset when nothing was stored', async () => {
    const consent = await fresh();
    expect(consent.consentState()).toBe('unset');
    expect(consent.readConsent()).toBeNull();
  });

  it('stores the choice with the copy version and the date it was made', async () => {
    const consent = await fresh();
    consent.setConsent('granted', new Date('2026-10-27T09:00:00.000Z'));
    expect(consent.consentState()).toBe('granted');
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}')).toEqual({
      state: 'granted',
      version: VERSION,
      date: '2026-10-27T09:00:00.000Z',
    });
  });

  it('is read back on the next page, and `denied` is a choice like any other', async () => {
    const first = await fresh();
    first.setConsent('denied', new Date('2026-10-27T09:00:00.000Z'));
    const second = await fresh();
    expect(second.consentState()).toBe('denied');
  });

  it('ignores a record made against another version of the copy', async () => {
    localStorage.setItem(KEY, JSON.stringify({ state: 'granted', version: '2026-01-01.1', date: '2026-01-01T00:00:00Z' }));
    const consent = await fresh();
    expect(consent.consentState()).toBe('unset');
  });

  it('ignores a malformed or undated record instead of trusting it', async () => {
    for (const raw of ['not json', '{}', '[]', 'null', JSON.stringify({ state: 'granted', version: VERSION }), JSON.stringify({ state: 'yes', version: VERSION, date: 'x' })]) {
      localStorage.setItem(KEY, raw);
      const consent = await fresh();
      expect(consent.consentState(), raw).toBe('unset');
    }
  });

  it('treats a browser-level refusal as a refusal, whatever was stored', async () => {
    vi.stubGlobal('navigator', { doNotTrack: '1' });
    const consent = await fresh();
    consent.setConsent('granted', new Date('2026-10-27T09:00:00.000Z'));
    expect(consent.consentState()).toBe('denied');
    expect(consent.doNotTrack()).toBe(true);
  });

  it('forgets the choice when the reader asks to change it', async () => {
    const consent = await fresh();
    consent.setConsent('denied');
    consent.resetConsent();
    expect(consent.consentState()).toBe('unset');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('survives a storage that throws (a hardened or private browser)', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const consent = await fresh();
    expect(consent.consentState()).toBe('unset');
    expect(() => consent.setConsent('granted')).not.toThrow();
    // The page still remembers the answer it was given, even when it cannot persist it.
    expect(consent.consentState()).toBe('granted');
  });

  it('notifies only while someone is listening', async () => {
    const consent = await fresh();
    const listener = vi.fn();
    const stop = consent.subscribeConsent(listener);
    consent.setConsent('granted');
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    consent.resetConsent();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
