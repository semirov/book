/**
 * Cookie parsing and serialisation (ARCHITECTURE.md §9, §17).
 *
 * The session cookie is the only credential a browser holds; the OAuth `state` cookie is a
 * ten-minute, path-scoped companion. Neither carries a token the client can read
 * (`HttpOnly`) and neither is ever set from a request value.
 */

export type CookieOptions = {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
  maxAgeSeconds?: number;
};

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (header === undefined || header.length === 0) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (name.length === 0 || Object.hasOwn(out, name)) continue;
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** RFC 6265 `Set-Cookie` value. `Max-Age=0` is the honest way to delete a cookie. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.trunc(options.maxAgeSeconds))}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}
