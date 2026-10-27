/**
 * The application-owned CSP (ARCHITECTURE.md invariants 27–28, §15.3, §17; F028).
 *
 * The header is computed once, from the deployment's own configuration: a challenge
 * provider's browser origins (none ship today — BOOK-64 dropped the widget), and Metrika's
 * single origin only when a counter id is configured. Nothing is pasted, nothing is widened
 * "just in case", and `unsafe-inline` is never emitted. BOOK-119 added one inline script to the
 * shell — the boot guard, which must survive a missing bundle — and it is allowed by its own
 * sha256 (`buildCsp(config, scriptHashes)`), hashed from the file this server sends; the theme
 * bootstrap stays a file so the policy keeps one hash and one meaning.
 *
 * The same holds for styles (BOOK-30): `style-src 'self'` stands alone, with no
 * `style-src-attr` and no `'unsafe-inline'`. That is hardening, not a workaround: React's
 * `style` prop already goes through CSSOM, and only a literal `style="…"` attribute (for
 * example from `dangerouslySetInnerHTML`) would be dropped. The SPA therefore keeps every
 * colour in a class and every DOM-known value in a CSSOM write (`web/src/lib/cssom.ts`).
 *
 * Nothing on the page needs a third-party byte: the reading path is third-party-free, and
 * the composer no longer loads a challenge script or iframe (BOOK-64).
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { CAPTCHA_SURFACES, METRIKA_ORIGIN } from '@book/shared';

import type { Config } from '../config.ts';

export type CspSource = Pick<Config, 'captchaProvider' | 'metrikaId' | 'publicOrigin'>;

/** `https://book.semirov.dev` → `wss://book.semirov.dev`. */
export function socketOrigin(publicOrigin: string): string {
  try {
    const url = new URL(publicOrigin);
    const protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    return `${protocol}//${url.host}`;
  } catch {
    return 'wss://book.semirov.dev';
  }
}

export function buildCsp(config: CspSource, scriptHashes: readonly string[] = []): string {
  const surface = CAPTCHA_SURFACES[config.captchaProvider];
  const metrika = config.metrikaId.trim().length > 0 ? [METRIKA_ORIGIN] : [];
  const hashes = scriptHashes.map((digest) => `'sha256-${digest}'`);
  const scripts = unique(['\'self\'', ...hashes, ...surface.scriptOrigins, ...metrika]);
  const frames = unique(surface.frameOrigins.length === 0 ? ['\'none\''] : [...surface.frameOrigins]);
  const connects = unique(['\'self\'', ...surface.connectOrigins, socketOrigin(config.publicOrigin), ...metrika]);
  const images = unique(['\'self\'', 'data:', ...metrika]);

  return [
    "default-src 'self'",
    `script-src ${scripts.join(' ')}`,
    "style-src 'self'",
    `img-src ${images.join(' ')}`,
    "font-src 'self'",
    `connect-src ${connects.join(' ')}`,
    `frame-src ${frames.join(' ')}`,
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
  ].join('; ');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * BOOK-119 — the shell's inline scripts, hashed exactly as the bytes will be served.
 *
 * Why the shell carries one inline script is explained above the guard in `web/index.html`
 * (and pinned by `web/src/lib/bootGuard.test.tsx`). The header is what lets it run without
 * `unsafe-inline`: an inline `<script>` is allowed only when its own bytes are listed. The
 * value is the sha256 of the text between the tags, base64 — the browser's own rule, nothing
 * translated.
 *
 * `null` means "this shell cannot be parsed into scripts": a `<script` without its closing tag,
 * or an HTML document that is not the shell at all. A caller then sends no hash (the guard stays
 * inert, exactly today's behaviour) and logs a warn — it never widens the policy to compensate.
 */
export function inlineScriptHashes(html: string): string[] | null {
  const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gu)];
  const opens = [...html.matchAll(/<script\b/gu)].length;
  if (blocks.length !== opens) return null;
  return blocks
    .filter((block) => !/\bsrc\s*=/u.test(block[1] ?? ''))
    .map((block) => createHash('sha256').update(block[2] ?? '', 'utf8').digest('base64'));
}

export type ShellHashes = { hashesFor: (root: string) => string[] };

/**
 * The hash of the shell **being sent**, memoised by `mtimeMs:size` (at most four shells).
 *
 * Hash and bytes cannot drift because both come from one read of one file: the response body is
 * `@fastify/static`'s copy of the same path, and a swap of `current` changes the resolved file
 * (path, mtime, size) — the next HTML response rehashes. The cache only removes the per-request
 * read of a file that is otherwise re-hashed on every page load.
 */
export function createShellHashes({
  warn = () => {},
  maxEntries = 4,
}: { warn?: (message: string) => void; maxEntries?: number } = {}): ShellHashes {
  const entries = new Map<string, { key: string; hashes: string[] }>();
  return {
    hashesFor(root: string): string[] {
      const file = join(root, 'index.html');
      let key: string;
      try {
        const stats = statSync(file);
        key = `${stats.mtimeMs}:${stats.size}`;
      } catch {
        key = 'missing';
      }
      const cached = entries.get(file);
      if (cached !== undefined && cached.key === key) return cached.hashes;

      let hashes: string[] = [];
      if (key !== 'missing') {
        try {
          const parsed = inlineScriptHashes(readFileSync(file, 'utf8'));
          if (parsed === null) {
            warn(`csp: ${file} has an unparsable inline script — no hash sent, the boot guard stays inert`);
          } else {
            hashes = parsed;
          }
        } catch {
          warn(`csp: ${file} could not be read — no hash sent, the boot guard stays inert`);
        }
      }

      entries.delete(file);
      entries.set(file, { key, hashes });
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      return hashes;
    },
  };
}
