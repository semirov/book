/**
 * The static layer's versions are a security boundary, not a detail (BOOK-27).
 *
 * CVE-2026-15074 (path traversal / route-guard bypass, high) lives in `@fastify/static`
 * ≤10.1.1, and the path sending it stands on is `@fastify/send` 4.2.0. `api.test.ts` proves
 * the current answer is contained; this file makes a **downgrade** fail the suite instead of
 * quietly returning the vulnerable code in a lockfile diff. The lockfile is the resolved
 * truth, so it is what the suite reads — no `npm ls`, no network.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SITE = join(import.meta.dirname, '..', '..');

const lock = JSON.parse(readFileSync(join(SITE, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { version?: string } | undefined>;
};

function versionOf(name: string): string {
  const resolved = lock.packages[`node_modules/${name}`]?.version;
  if (resolved === undefined) throw new Error(`${name} is not resolved in package-lock.json`);
  return resolved;
}

/** Numeric-triple comparison: a prerelease counts as its release, which is strict enough here. */
function atLeast(version: string, floor: string): boolean {
  const left = version.split('-')[0]!.split('.').map(Number);
  const right = floor.split('-')[0]!.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l > r;
  }
  return true;
}

describe('the static layer stays patched', () => {
  it('keeps @fastify/static above the vulnerable line (≤10.1.1 is CVE-2026-15074)', () => {
    const resolved = versionOf('@fastify/static');
    // 10.1.2 is the first fixed release: `≥10.1.1` would still admit the vulnerable 10.1.1.
    expect(atLeast(resolved, '10.1.2'), resolved).toBe(true);
    // And the guard itself is honest: the floor rejects what the audit called vulnerable.
    expect(atLeast('10.1.1', '10.1.2')).toBe(false);
    expect(atLeast('8.3.0', '10.1.2')).toBe(false);
  });

  it('sends files with the patched @fastify/send 4.2.0 line', () => {
    const resolved = versionOf('@fastify/send');
    expect(atLeast(resolved, '4.2.0'), resolved).toBe(true);
    // Another major is a different contract: it would have to be audited, not waved through.
    expect(resolved.split('.')[0]).toBe('4');
  });
});
