import { createECDH, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { readVapid, type VapidKeys } from '../../src/push/vapid.ts';

/**
 * BOOK-189 — the VAPID key, as a file.
 *
 * The contract has exactly three outcomes, and the difference between them is the difference
 * between «a site without push» and «a deployment that is broken»: absent is normal, everything
 * else is `VAPID_KEY_INVALID` and never carries the path, the content or a byte of the key. The
 * public half is derived here from the PEM's own scalar, so the test does not trust the module's
 * answer to check the module.
 */

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-vapid-'));
  dirs.push(dir);
  return dir;
}

function writeVapidKey(): { file: string; keys: VapidKeys; scalar: Buffer } {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const file = join(tempDir(), 'vapid');
  writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
  const jwk = privateKey.export({ format: 'jwk' }) as { d?: string };
  const scalar = Buffer.from(jwk.d ?? '', 'base64url');
  const read = readVapid(file);
  if (read.keys === null) throw new Error('the generated key did not read back');
  return { file, keys: read.keys, scalar };
}

function pointOf(scalar: Buffer): string {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(scalar);
  return ecdh.getPublicKey().toString('base64url');
}

describe('readVapid', () => {
  it('reads a missing file as «push is off», not as a problem', () => {
    expect(readVapid(join(tempDir(), 'absent'))).toEqual({ keys: null, problem: null });
  });

  it('treats a directory as unreadable, not as an absent key', () => {
    const read = readVapid(tempDir());
    expect(read.keys).toBeNull();
    expect(read.problem).toBe('VAPID_KEY_INVALID');
  });

  it('refuses an empty file', () => {
    const file = join(tempDir(), 'vapid');
    writeFileSync(file, '   \n', 'utf8');
    expect(readVapid(file)).toEqual({ keys: null, problem: 'VAPID_KEY_INVALID' });
  });

  it('refuses a PEM that is not a P-256 key', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const file = join(tempDir(), 'vapid');
    writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8');
    expect(readVapid(file)).toEqual({ keys: null, problem: 'VAPID_KEY_INVALID' });
  });

  it('a P-384 key is not a VAPID key either', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const file = join(tempDir(), 'vapid');
    writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8');
    expect(readVapid(file)).toEqual({ keys: null, problem: 'VAPID_KEY_INVALID' });
  });

  it('reads the deployment PEM into base64url halves that match the scalar', () => {
    const pair = writeVapidKey();
    expect(Buffer.from(pair.keys.privateKey, 'base64url')).toEqual(pair.scalar);
    expect(pair.keys.publicKey).toBe(pointOf(pair.scalar));
    // An uncompressed P-256 point: one tag byte and two 32-byte coordinates.
    const point = Buffer.from(pair.keys.publicKey, 'base64url');
    expect(point.length).toBe(65);
    expect(point[0]).toBe(0x04);
  });

  it('never reports the path or the content of a bad file', () => {
    const file = join(tempDir(), 'vapid');
    writeFileSync(file, 'not a key at all', 'utf8');
    const read = readVapid(file);
    expect(JSON.stringify(read)).not.toContain(file);
    expect(JSON.stringify(read)).not.toContain('not a key');
  });
});
