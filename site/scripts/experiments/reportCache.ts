/**
 * The cache matrix as the summary prints it (BOOK-DOC-65 §6, corrected): one row per call, the
 * numbers, and what the number *means*. The interpretation lives here and not in the artifact,
 * because the artifact is a measurement and this is a reading of it.
 */

import { listArtifacts } from './store.ts';

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * What a cache row did, in the terms the row was written for. A variant that hits although the
 * layout should have killed it is reported as a **hit**, with what it means: the provider matches
 * content units rather than one byte prefix, and the layout loses its leverage.
 */
function cacheReading(metrics: Record<string, unknown>): string {
  const hit = num(metrics.cacheHit) ?? 0;
  const reference = num(metrics.referenceTokens) ?? 0;
  const variant = String(metrics.variant ?? '');
  const share = reference === 0 ? 0 : hit / reference;
  const asPercent = `${(share * 100).toFixed(0)} %`;
  const divergence = record(metrics.divergence);
  const expectedBefore = num(divergence?.tokens);

  if (variant === 'W1' || variant === 'H4a') {
    return share > 0.1 ? `hit ${asPercent} with no warm call in this run` : 'cold, as expected';
  }
  if (variant === 'H1') {
    return share > 0.1
      ? `hit ${asPercent} anyway — matched despite the reordering (content units, not a byte prefix)`
      : 'no hit: byte order is the key, as expected';
  }
  if (expectedBefore !== null && expectedBefore !== undefined) {
    const expectedShare = reference === 0 ? 0 : expectedBefore / reference;
    if (share >= expectedShare * 0.9 && share <= expectedShare * 1.1 + 0.05) {
      return `hit ${asPercent} — stops at the changed byte (≈ ${String(Math.round(expectedShare * 100))} % expected)`;
    }
    if (share > expectedShare * 1.1 + 0.05) {
      return `hit ${asPercent}, past the change (≈ ${String(Math.round(expectedShare * 100))} % expected) — content units again`;
    }
    return share === 0
      ? `0 — the whole prefix is lost, not only its tail (≈ ${String(Math.round(expectedShare * 100))} % was predicted before the change)`
      : `hit ${asPercent}, short of the change (≈ ${String(Math.round(expectedShare * 100))} % expected)`;
  }
  return share >= 0.9 ? `hit ${asPercent} — the whole reference is cacheable` : share > 0.1 ? `partial: ${asPercent}` : 'no hit';
}

export function cacheRows() {
  return listArtifacts('cache')
    .map((artifact) => {
      const run = record(artifact.run) ?? {};
      const metrics = record(artifact.metrics) ?? {};
      const divergence = record(metrics.divergence);
      return {
        artifact: artifact.artifact,
        call: num(metrics.call),
        variant: String(metrics.variant ?? run.variant ?? '?'),
        title: String(run.title ?? ''),
        what: String(run.what ?? metrics.what ?? ''),
        promptTokens: num(metrics.promptTokens),
        cacheHit: num(metrics.cacheHit),
        cacheMiss: num(metrics.cacheMiss),
        referenceTokens: num(metrics.referenceTokens),
        hitRate: num(metrics.hitRate),
        expected: String(metrics.expected ?? ''),
        proves: String(run.proves ?? metrics.proves ?? ''),
        divergence: divergence === null ? null : { bytes: num(divergence.bytes) ?? 0, tokens: num(divergence.tokens) ?? 0 },
        refusal: typeof metrics.refusal === 'string' ? metrics.refusal : null,
        reading: cacheReading(metrics),
      };
    })
    // The matrix is read in the order it was sent: W1, H0, H1, H2, H3, H4a, H4b.
    .sort((a, b) => (a.call ?? 0) - (b.call ?? 0));

}
