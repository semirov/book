/**
 * The client's network identity behind Caddy (ARCHITECTURE.md §14).
 *
 * `X-Forwarded-For` is believed **only** when the socket peer is a configured proxy;
 * otherwise a direct client could name its own address and dodge the per-IP limits.
 * Raw IPs never leave this module in a persisted form: the rate store keeps a hash.
 */

export type HeaderBag = Record<string, string | string[] | undefined>;

export const DEFAULT_TRUSTED_PROXIES = ['127.0.0.1', '::1'];

/** `::ffff:127.0.0.1` → `127.0.0.1`; a bracketed IPv6 or `ip:port` loses its decoration. */
export function normalizeIp(raw: string): string {
  let value = raw.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    value = end >= 0 ? value.slice(1, end) : value.slice(1);
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/u.test(value)) {
    value = value.slice(0, value.lastIndexOf(':'));
  }
  if (value.startsWith('::ffff:') && value.includes('.')) value = value.slice('::ffff:'.length);
  return value;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    result = result * 256 + octet;
  }
  return result >>> 0;
}

function expandIpv6(ip: string): string[] | null {
  if (!ip.includes(':')) return null;
  const [head = '', tail = ''] = ip.split('::');
  const headParts = head.length > 0 ? head.split(':') : [];
  const tailParts = tail.length > 0 ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0 || (ip.includes('::') && missing === 0)) return null;
  const parts = [...headParts, ...new Array<string>(Math.max(0, missing)).fill('0'), ...tailParts];
  if (parts.length !== 8) return null;
  return parts.map((part) => part.padStart(4, '0'));
}

/** `10.0.0.0/8`, `127.0.0.1`, `::1`, `fd00::/8`. A malformed entry matches nothing. */
export function ipInRange(ip: string, range: string): boolean {
  const value = normalizeIp(ip);
  const trusted = normalizeIp(range);
  const [network, prefixText] = trusted.split('/');
  if (network === undefined) return false;
  const prefix = prefixText === undefined ? null : Number(prefixText);
  if (prefix !== null && (!Number.isInteger(prefix) || prefix < 0 || prefix > 128)) return false;

  const v4Network = ipv4ToInt(network);
  const v4Value = ipv4ToInt(value);
  if (v4Network !== null && v4Value !== null) {
    const bits = prefix ?? 32;
    if (bits > 32) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
    return (v4Network & mask) >>> 0 === (v4Value & mask) >>> 0;
  }

  const networkParts = expandIpv6(network);
  const valueParts = expandIpv6(value);
  if (networkParts === null || valueParts === null) return false;
  const bits = prefix ?? 128;
  const fullHextets = Math.floor(bits / 16);
  const remainder = bits % 16;
  for (let index = 0; index < fullHextets; index += 1) {
    if (networkParts[index] !== valueParts[index]) return false;
  }
  if (remainder === 0) return true;
  const mask = (0xffff << (16 - remainder)) & 0xffff;
  const left = Number.parseInt(networkParts[fullHextets] ?? '0', 16) & mask;
  const right = Number.parseInt(valueParts[fullHextets] ?? '0', 16) & mask;
  return left === right;
}

export function isTrustedProxy(ip: string, trusted: readonly string[]): boolean {
  return trusted.some((range) => ipInRange(ip, range));
}

/** IPv6 is grouped by /64: one household with a rotating /128 is still one household (§14). */
export function ipKey(ip: string): string {
  const value = normalizeIp(ip);
  const parts = expandIpv6(value);
  if (parts === null) return value;
  return `${parts.slice(0, 4).join(':')}::/64`;
}

export function clientIp(headers: HeaderBag, peer: string, trusted: readonly string[] = DEFAULT_TRUSTED_PROXIES): string {
  const peerIp = normalizeIp(peer);
  if (!isTrustedProxy(peerIp, trusted)) return peerIp;

  const forwarded = headers['x-forwarded-for'];
  const chain = Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '');
  const hops = chain
    .split(',')
    .map((hop) => normalizeIp(hop))
    .filter((hop) => hop.length > 0);
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = hops[index];
    if (hop !== undefined && !isTrustedProxy(hop, trusted)) return hop;
  }

  const real = headers['x-real-ip'];
  const realIp = Array.isArray(real) ? real[0] : real;
  if (typeof realIp === 'string' && realIp.trim().length > 0) return normalizeIp(realIp);
  return peerIp;
}

/** The key a per-IP limit counts against: never the raw address in storage. */
export function connectionKey(ip: string): string {
  return ipKey(ip);
}
