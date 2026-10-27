/**
 * A production-shaped env for `loadConfig` tests (ARCHITECTURE.md invariant 30): production
 * takes every secret from a `0600` file, so the fixture writes real files instead of plain
 * values. Each `secretFile` call writes a new file, so a test that swaps one secret in leaves
 * the others alone. A suite that imports this calls `cleanupSecretFiles` in `afterAll`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const secretsDir = mkdtempSync(join(tmpdir(), 'book-prod-secrets-'));
let secretSeq = 0;

/** Writes `value` to a fresh `0600` file and returns its path. */
export function secretFile(value: string): string {
  const path = join(secretsDir, `secret-${String(++secretSeq)}`);
  writeFileSync(path, value, { mode: 0o600 });
  return path;
}

/** A path under the same directory that no test ever writes: a declared file that is absent. */
export function absentSecretFile(name: string): string {
  return join(secretsDir, `absent-${name.toLowerCase()}`);
}

export function cleanupSecretFiles(): void {
  rmSync(secretsDir, { recursive: true, force: true });
}

/** A valid production shape, so each refusal in a test fails for exactly one reason. */
export const production = {
  NODE_ENV: 'production',
  PUBLIC_ORIGIN: 'https://book.test',
  SESSION_SECRET_FILE: secretFile('session-secret-from-test'),
  IP_SALT_FILE: secretFile('ip-salt-from-test'),
  CAPTCHA_PROVIDER: 'turnstile',
  CAPTCHA_SECRET_FILE: secretFile('captcha-secret-from-test'),
  CAPTCHA_SITE_KEY: 'captcha-site-key-from-test',
} as const;
