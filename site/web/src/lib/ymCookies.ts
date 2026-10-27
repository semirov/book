/**
 * BOOK-77 (audit F2) — the first-party cookies the Metrika tag writes.
 *
 * `_ym_uid`, `_ym_d`, `_ym_isad` and `_ym_visorc` are set on the site's own host, sometimes on
 * its parent domain. Withdrawal has to take them back **now**, not wait for their own expiry:
 * the consent line promises analytics only while the reader allows it (comment #3619).
 */

/** Every cookie the tag writes starts with this prefix (the vendor's naming, not ours). */
export const YM_COOKIE_PREFIX = '_ym_';

/** An IPv4 literal has no parent domain: only a name can carry one. */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/**
 * The cookie domains to try for `hostname`: the host itself, then every parent that still has
 * two labels (`book.semirov.dev` → `book.semirov.dev`, `semirov.dev`). Browsers treat
 * `example.com` and `.example.com` as one cookie host, so no leading dot is needed.
 */
export function cookieDomains(hostname: string): string[] {
  const host = hostname.trim().toLowerCase().replace(/^\.+/u, '');
  if (host.length === 0) return [];
  const labels = host.split('.').filter((label) => label.length > 0);
  if (labels.length < 2 || IPV4.test(host)) return [host];
  const out: string[] = [];
  for (let index = 0; index < labels.length; index += 1) {
    const domain = labels.slice(index).join('.');
    if (domain.split('.').length >= 2) out.push(domain);
  }
  return out;
}

/** The `_ym_*` names present in a `document.cookie` string, without duplicates. */
export function ymCookieNames(cookie: string): string[] {
  const names = new Set<string>();
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    const name = (separator === -1 ? part : part.slice(0, separator)).trim();
    if (name.startsWith(YM_COOKIE_PREFIX)) names.add(name);
  }
  return [...names];
}

/**
 * Delete every `_ym_*` cookie on `hostname` — host-only, then each parent domain — and return
 * the names that were found. A browser that refuses one domain (a sandboxed frame, an invalid
 * domain, a cookie that is already gone) must not stop the rest: each attempt stands alone.
 */
export function clearYmCookies(doc: Document, hostname: string): string[] {
  const names = ymCookieNames(doc.cookie);
  for (const name of names) {
    for (const suffix of ['', ...cookieDomains(hostname).map((domain) => `; domain=${domain}`)]) {
      try {
        doc.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT${suffix}`;
      } catch {
        // Nothing to do for this cookie on this domain: the reader's browser keeps the rest.
      }
    }
  }
  return names;
}
