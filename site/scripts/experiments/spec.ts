/**
 * The A/B/C experiment (BOOK-DOC-65 §6): what is measured, at which prices, under which cap.
 *
 * One file holds every decision a run must not make on the fly — the three filings, the three
 * chapter labels, the token caps, the price basis and the spend cap. A number that changed
 * between two runs would make the table incomparable, so nothing here is read from the
 * transcript of an earlier run.
 *
 * The prices are the book's table (`site/config/pipeline.json`, BOOK-114) plus the provider's
 * peak window: the provider doubles **all three** rates in it, so `peak` is a multiplier over
 * the same three numbers and never a second price list.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** `site/scripts/experiments` → `site/scripts` → `site` → the book root. */
export const BOOK_ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const SITE_ROOT = resolve(BOOK_ROOT, 'site');
/**
 * Where the artifacts go. `EXPERIMENTS_DIR` exists for `selftest.ts`, which runs the whole
 * harness against a fake provider and must not leave its fixtures among the real rows.
 */
export const DATA_DIR = (process.env.EXPERIMENTS_DIR ?? '').trim() || resolve(SITE_ROOT, '.data', 'experiments');

/** The hard stop: the projected total on the peak basis may not cross this (`spend_cap`). */
export const CAP_USD = 1.75;
/** The provider doubles all three rates in its peak window (BOOK-DOC-65 §6). */
export const PEAK_MULTIPLIER = 2;

/** One writing attempt per mode, one gate pass per landed result — caps, not targets. */
export const A_MAX_TOKENS = 24_000;
export const B_MAX_TOKENS = 12_000;
export const GATE_MAX_TOKENS = 8_000;
export const CACHE_MAX_TOKENS = 64;
export const SMOKE_MAX_TOKENS = 8;

/** The applier's budget (BOOK-DOC-65 §2 step 7). */
export const PATCH_MAX_FRACTION = 0.15;

/** The pass contract this harness stands in for: `pass: 'change'`, cycle 0, no note. */
export const PASS = 'change';
export const CYCLE = 0;

/**
 * How long to wait between a call that warms a prefix and the call that should hit it (§6 C).
 * The provider's cache is automatic, so the only lever is time.
 */
export const CACHE_WARM_WAIT_MS = Number((process.env.EXPERIMENTS_WAIT_MS ?? '').trim() || 5_000);

/**
 * A conservative token estimate for a Cyrillic prompt: Russian runs ~2–3 characters per token
 * in this provider's tokenizer, so `chars / 2` **overstates** the count. It is used only for
 * the dry run's sizes and for the cap's projection, never for a reported cost — a reported cost
 * is always the provider's own `usage`.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 2);
}

export type FilingLabel = 'ch01' | 'ch03' | 'ch06';

/**
 * One filing, copied from `changes` in `~/book-site-data/book.db` (read-only) on 2026-10-28.
 * Nothing that identifies a reader travels: `intent`, `kind`, `scopeHint` are the whole spec.
 */
export type Filing = {
  label: FilingLabel;
  chapter: number;
  /** `changes.id`, for the report only — it is never sent to the model. */
  id: string;
  kind: 'accepted_comment' | 'operator';
  /** `changes.scope_hint`: all three are phrase-scope, so all three are patch-eligible. */
  scopeHint: 'phrase';
  intent: string;
  proposedText: string | null;
};

export const FILINGS: readonly Filing[] = [
  {
    label: 'ch01',
    chapter: 1,
    id: 'chg_01M61C0N4S678MF6KMYJNCFCPD',
    kind: 'accepted_comment',
    scopeHint: 'phrase',
    intent: 'Он забыл документы дома',
    proposedText: 'Он забыл документы дома',
  },
  {
    label: 'ch03',
    chapter: 3,
    id: 'chg_01M61C0N4S678MF6KMYJNCFCPB',
    kind: 'accepted_comment',
    scopeHint: 'phrase',
    intent: 'Гуси',
    proposedText: 'Часы и хлеб',
  },
  {
    label: 'ch06',
    chapter: 6,
    id: 'chg_01M60RQ6583W1EQ6QP61CEFV4H',
    kind: 'operator',
    scopeHint: 'phrase',
    intent:
      'Приём заявления открывает протокол 14-УП: подпись заявителя оспорена, и до заключения он не вправе заверять копии.',
    proposedText: null,
  },
] as const;

export const LABELS: readonly FilingLabel[] = ['ch01', 'ch03', 'ch06'];

export function filingOf(label: string): Filing {
  const filing = FILINGS.find((entry) => entry.label === label);
  if (filing === undefined) throw new Error(`unknown filing «${label}»; the experiment has ch01, ch03, ch06`);
  return filing;
}

/** `--only=ch01,ch06` → the two filings; an empty flag means all three. */
export function selectFilings(only: string | null): Filing[] {
  if (only === null || only.trim().length === 0) return [...FILINGS];
  const wanted = only
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return wanted.map((label) => filingOf(label));
}

/** The key: the file named by `DEEPSEEK_API_KEY_FILE`, else the owner's default location. */
export const DEFAULT_KEY_FILE = '/Users/filipp/.config/book/deepseek.key';

export function keyFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const declared = (env.DEEPSEEK_API_KEY_FILE ?? '').trim();
  return declared.length > 0 ? declared : DEFAULT_KEY_FILE;
}

/** `null` when the file is absent or empty: a missing key is a stated skip, never a crash. */
export function readKey(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const value = readFileSync(keyFilePath(env), 'utf8');
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
