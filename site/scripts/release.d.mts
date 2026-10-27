/** Types for `scripts/release.mjs` — BOOK-119's versioned releases. */

export type BuildIdentity = { sha: string; short: string };
export type Release = { id: string; root: string; publishedAt: string };
export type TreeDigest = { files: number; bytes: number; digest: string };
export type PublishResult = { id: string; created: boolean; pruned: string[]; files?: number; bytes?: number };
export type ReleaseManifest = {
  id: string;
  sha: string;
  builtAt: string | null;
  stamp: string | null;
  publishedAt: string;
  files?: number;
  bytes?: number;
};

export const DEFAULT_WEB_DIST: string;
export const DEFAULT_STATE_DIR: string;
export const DEFAULT_KEEP: number;
export const MANIFESTS: string;

export function compactStamp(date: Date): string;
export function readBuildInfo(siteRoot?: string): { commit?: unknown; builtAt?: unknown; stamp?: unknown };
export function buildIdentity(options?: { siteRoot?: string; sha?: string }): BuildIdentity;
export function walkFiles(dir: string, base?: string, out?: string[]): string[];
export function treeDigest(dir: string): TreeDigest;
export function currentReleaseId(webDist?: string): string | null;
export function manifestPath(webDist: string, id: string): string;
export function releaseManifest(webDist: string, id: string): ReleaseManifest | null;
export function writeManifest(webDist: string, id: string, manifest: ReleaseManifest): void;
export function listReleases(webDist?: string): Release[];
export function readLastGoodRelease(stateDir?: string): string | null;
export function writeLastGoodRelease(id: string, stateDir?: string): void;
export function adoptLegacy(webDist?: string, date?: Date): string | null;
export function swapCurrent(webDist: string, id: string): void;
export function swap(options?: { webDist?: string; id: string }): { id: string };
export function prune(options?: {
  webDist?: string;
  keep?: number;
  stateDir?: string;
  log?: (line: string) => void;
}): string[];
export function publish(options?: {
  webDist?: string;
  siteRoot?: string;
  stateDir?: string;
  keep?: number;
  sha?: string;
  now?: Date;
  log?: (line: string) => void;
}): PublishResult;
export function main(argv: string[]): number;
