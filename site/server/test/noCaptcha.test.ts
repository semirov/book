import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SITE_ROOT } from '../src/config.ts';

/**
 * BOOK-64 / AC3 — no CAPTCHA survives in the client, the built asset or the header.
 *
 * A grep-level test on purpose: the removal is a product decision, not a behaviour a unit
 * test can observe from one component. The source tree is always checked; the built asset is
 * checked when a build exists (`npm run build` produces it), so a stale bundle that still
 * loads `challenges.cloudflare.com` cannot pass unnoticed.
 */

const CLIENT_SRC = join(SITE_ROOT, 'web', 'src');
const CLIENT_DIST = join(SITE_ROOT, 'web', 'dist');

/** The markers a challenge would leave: a widget, a vendor origin, a vendor name. */
const CHALLENGE_MARKERS = [
  /challenges\.cloudflare\.com/iu,
  /turnstile/iu,
  /hcaptcha/iu,
  /seam-captcha/iu,
  /проверка\s*[·«]/iu,
];

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path));
    else found.push(path);
  }
  return found;
}

describe('the client carries no challenge (BOOK-64)', () => {
  it('has no widget, iframe or vendor origin anywhere in web/src', () => {
    // Product sources only: a test may name the thing it asserts is gone.
    const files = filesUnder(CLIENT_SRC).filter((file) => !/\.test\.tsx?$/u.test(file));
    // A sanity floor: an empty or moved tree must fail, not pass vacuously.
    expect(files.length).toBeGreaterThan(40);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const marker of CHALLENGE_MARKERS) {
        expect(marker.test(text), `${file} matches ${String(marker)}`).toBe(false);
      }
    }
    // The form's markup is the concrete place the widget used to be.
    const form = readFileSync(join(CLIENT_SRC, 'components', 'InterventionForm.tsx'), 'utf8');
    expect(form).not.toContain('captchaToken');
    expect(form).toContain('postAnchoredComment(');
  });

  it('ships a built asset with no challenge script or iframe', () => {
    const entry = join(CLIENT_DIST, 'index.html');
    if (!existsSync(entry)) return; // no build in this checkout; `npm run build` is the gate
    const assetsDir = join(CLIENT_DIST, 'assets');
    const assets = [entry, ...(existsSync(assetsDir) ? filesUnder(assetsDir) : [])];
    for (const file of assets) {
      const text = readFileSync(file, 'utf8');
      for (const marker of CHALLENGE_MARKERS) {
        expect(marker.test(text), `${file} matches ${String(marker)}`).toBe(false);
      }
    }
  });
});
