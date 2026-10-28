/**
 * The VAPID key (BOOK-189) — read once at boot, and never by anything else.
 *
 * A Web Push message is signed with a P-256 key pair, so the site needs a private scalar and the
 * matching public point. The pair lives in a `0600` file as PEM PKCS#8 (`-----BEGIN PRIVATE
 * KEY-----`); the private half never leaves this module, and the public half is the only thing
 * the page is ever told.
 *
 * Two decisions shape the contract:
 *
 *   · **An absent file is not an error.** A deployment that has not set push up is a normal
 *     site, so a missing path reads as «push is off» and the drain timer never starts. Everything
 *     else — an unreadable, empty or malformed file — is a stable code (`VAPID_KEY_INVALID`) that
 *     a boot can log once. The code never carries the path, the key bytes or the file's content:
 *     a log line that names them is a leak, and this module is the only place that could make
 *     one.
 *   · **The public point is derived from the private scalar**, not copied from the file's JWK.
 *     A key pair whose halves disagree produces messages no push service accepts, and the
 *     failure would surface as a silent `error` on every send. `createECDH` does the arithmetic
 *     (`setPrivateKey(d)` → `getPublicKey()`), so no crypto primitive is hand-rolled here.
 */

import { createECDH, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type VapidKeys = { privateKey: string; publicKey: string };

export type VapidRead = {
  /** `null` when push is off or the file is broken; `problem` says which. */
  keys: VapidKeys | null;
  /** A stable code for the operator log — never a path, never key material. */
  problem: 'VAPID_KEY_INVALID' | null;
};

export const VAPID_KEY_INVALID = 'VAPID_KEY_INVALID';

/** The one shape of a broken key: push off, and a code an operator can look up. */
const INVALID: VapidRead = { keys: null, problem: VAPID_KEY_INVALID };
const OFF: VapidRead = { keys: null, problem: null };

/** A base64url scalar of a P-256 private key is exactly 32 bytes. */
const SCALAR_BYTES = 32;
/** An uncompressed point: `0x04 || x || y`, 32 bytes per coordinate. */
const POINT_BYTES = 65;
const UNCOMPRESSED = 0x04;

export function readVapid(file: string): VapidRead {
  let pem: string;
  try {
    pem = readFileSync(file, 'utf8');
  } catch (error) {
    // ENOENT is the supported «push is off» state; every other failure (a directory, a
    // permission, a broken mount) is a deployment problem worth one line in the boot log.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? OFF : INVALID;
  }
  if (pem.trim().length === 0) return INVALID;

  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ec') return INVALID;
    const jwk = key.export({ format: 'jwk' }) as { crv?: string; d?: string };
    if (jwk.crv !== 'P-256' || jwk.d === undefined) return INVALID;
    const scalar = Buffer.from(jwk.d, 'base64url');
    if (scalar.length !== SCALAR_BYTES) return INVALID;

    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(scalar);
    const point = ecdh.getPublicKey();
    if (point.length !== POINT_BYTES || point[0] !== UNCOMPRESSED) return INVALID;

    return {
      keys: { privateKey: scalar.toString('base64url'), publicKey: point.toString('base64url') },
      problem: null,
    };
  } catch {
    // `createPrivateKey` throws on text that is not a key, and JWK export throws on a key it
    // cannot describe; both are the same answer to the caller.
    return INVALID;
  }
}
