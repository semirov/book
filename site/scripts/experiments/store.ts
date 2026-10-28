/**
 * The experiment's shelf: one JSON artifact per measured thing, under `site/.data/experiments/`.
 *
 * `.data/` is git-ignored and nothing here is committed, so the artifacts are evidence for the
 * design note rather than a shipped file. An artifact is the whole row: the request's section
 * map (ids, sizes, hashes — never a second copy of the canon), the response, the provider's
 * usage, the derived metrics. Two rules:
 *
 *  · **resume by default** — an artifact that is complete and was produced by the same prompt
 *    bytes is not re-run; `--force` re-runs it;
 *  · **no secrets and no path of one** — only numbers, hashes, section ids and prose.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { DATA_DIR } from './spec.ts';

export type Artifact = {
  /** `<command>-<id>.json` — the id is what the table and the resume address. */
  artifact: string;
  command: string;
  id: string;
  createdAt: string;
  complete: boolean;
  [key: string]: unknown;
};

export function artifactPath(fileName: string): string {
  return join(DATA_DIR, fileName);
}

export function saveArtifact(fileName: string, data: Record<string, unknown>): Artifact {
  mkdirSync(DATA_DIR, { recursive: true });
  const artifact: Artifact = {
    ...data,
    artifact: fileName,
    command: typeof data.command === 'string' ? data.command : fileName.split('-')[0] ?? 'unknown',
    id: typeof data.id === 'string' ? data.id : fileName.replace(/\.json$/u, ''),
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
    complete: data.complete !== false,
  };
  writeFileSync(artifactPath(fileName), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return artifact;
}

export function loadArtifact(fileName: string): Artifact | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(artifactPath(fileName), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Artifact) : null;
  } catch {
    return null;
  }
}

/** `ab`, `gates`, `cache`, `smoke` — every finished artifact whose name starts with the prefix. */
export function listArtifacts(prefix: string): Artifact[] {
  try {
    return readdirSync(DATA_DIR)
      .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.json'))
      .sort()
      .map((name) => loadArtifact(name))
      .filter((entry): entry is Artifact => entry !== null);
  } catch {
    return [];
  }
}

/**
 * The resume decision. A complete artifact is reused only when the request bytes still match:
 * a prompt that changed since the artifact was written makes it a measurement of something
 * else, and reusing it would be a table row that is not true.
 */
export function reusable(existing: Artifact | null, promptSha256: string | null): boolean {
  if (existing === null || existing.complete !== true) return false;
  if (promptSha256 === null) return true;
  const request = existing.request as { promptSha256?: unknown } | undefined;
  return request?.promptSha256 === promptSha256;
}

/** The experiment's spend so far. Written after every call, so a second command cannot reset it. */
export type SpendSoFar = { calls: number; usdBook: number; usdPeak: number };

export function loadSpend(): SpendSoFar {
  const artifact = loadArtifact('spend.json');
  const asNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return {
    calls: asNumber(artifact?.calls),
    usdBook: asNumber(artifact?.usdBook),
    usdPeak: asNumber(artifact?.usdPeak),
  };
}

export function saveSpend(spend: SpendSoFar): void {
  saveArtifact('spend.json', { command: 'spend', id: 'spend', ...spend });
}
