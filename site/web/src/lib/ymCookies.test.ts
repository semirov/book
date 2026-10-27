// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { clearYmCookies, cookieDomains, ymCookieNames } from './ymCookies.ts';

/**
 * BOOK-77 (audit F2) — the `_ym_*` cookies are taken back on withdrawal.
 *
 * The tag writes first-party cookies on the site's host and, when the site lives on a
 * subdomain, on the parent as well; a host-only cookie and a parent-domain cookie need two
 * different deletion attempts. The browser is the judge here: a `document.cookie` that no
 * longer names `_ym_*` is the only outcome that counts.
 */

function cookieNames(): string[] {
  return ymCookieNames(document.cookie);
}

/** The file's own jar must not carry a previous case's cookie into the next one. */
function clearJar(): void {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]?.trim() ?? '';
    if (name.length > 0) document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
}

afterEach(clearJar);

describe('the cookie domains a withdrawal must reach', () => {
  it('names the host and each parent that still has two labels', () => {
    expect(cookieDomains('book.semirov.dev')).toEqual(['book.semirov.dev', 'semirov.dev']);
    expect(cookieDomains('a.b.c.example')).toEqual(['a.b.c.example', 'b.c.example', 'c.example']);
    expect(cookieDomains('semirov.dev')).toEqual(['semirov.dev']);
  });

  it('normalises case and a leading dot, and keeps a single-label host whole', () => {
    expect(cookieDomains('.Book.Semirov.DEV')).toEqual(['book.semirov.dev', 'semirov.dev']);
    expect(cookieDomains('localhost')).toEqual(['localhost']);
  });

  it('treats an address literal as its own host, never as a parent chain', () => {
    expect(cookieDomains('10.0.0.5')).toEqual(['10.0.0.5']);
    expect(cookieDomains('')).toEqual([]);
    expect(cookieDomains('   ')).toEqual([]);
  });
});

describe('the names in a cookie string', () => {
  it('keeps only the vendor’s own prefix, without values and without duplicates', () => {
    expect(ymCookieNames('_ym_uid=1; _ym_d=2; book.consent.metrika=x; _ym_uid=3')).toEqual(['_ym_uid', '_ym_d']);
    expect(ymCookieNames('')).toEqual([]);
    expect(ymCookieNames('session=abc; theme=night')).toEqual([]);
  });

  it('reads a name a client sent without a value', () => {
    // Not every producer writes `name=value`; a bare name is still that cookie.
    expect(ymCookieNames('_ym_uid; _ym_d=2')).toEqual(['_ym_uid', '_ym_d']);
  });
});

describe('clearing the cookies on withdrawal', () => {
  it('deletes every `_ym_*` cookie and leaves the rest of the jar alone', () => {
    document.cookie = '_ym_uid=123456';
    document.cookie = '_ym_visorc=w';
    document.cookie = 'book.theme=night';
    expect(cookieNames()).toHaveLength(2);

    const cleared = clearYmCookies(document, location.hostname);

    expect(cleared.sort()).toEqual(['_ym_uid', '_ym_visorc']);
    expect(cookieNames()).toEqual([]);
    expect(document.cookie).toContain('book.theme=night');
  });

  it('does nothing, and says so, when the tag left no cookie', () => {
    expect(clearYmCookies(document, 'book.semirov.dev')).toEqual([]);
    expect(document.cookie).toBe('');
  });

  it('keeps going when a domain is refused, so one bad host cannot save the others', () => {
    document.cookie = '_ym_uid=123456';
    const attempts: string[] = [];
    const hostile = {
      get cookie() {
        return document.cookie;
      },
      set cookie(value: string) {
        attempts.push(value);
        if (value.includes('domain=semirov.dev')) throw new Error('refused');
        document.cookie = value;
      },
    } as Document;

    expect(clearYmCookies(hostile, 'book.semirov.dev')).toEqual(['_ym_uid']);
    // Host-only, the host itself, and the parent — all three were attempted.
    expect(attempts).toHaveLength(3);
    expect(attempts.some((value) => value.includes('domain=book.semirov.dev'))).toBe(true);
    expect(attempts.some((value) => value.includes('domain=semirov.dev'))).toBe(true);
    expect(cookieNames()).toEqual([]);
  });
});
