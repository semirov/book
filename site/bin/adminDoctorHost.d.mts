/**
 * Types for `bin/adminDoctorHost.mjs` (BOOK-188), the host half of the preflight: every export the
 * module has, so a test reads the same surface the CLI does.
 */

export type DockerAnswer = { code: number; stdout: string; stderr: string };
export type DockerCall = (args: string[]) => Promise<DockerAnswer>;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** One request's answer: the response, or the sentence that says why there is none. */
export type CallResult = { status: number; ok: boolean; body: unknown } | { error: string };

/** A read-only sqlite handle: the one method the doctor needs, plus `close`. */
export type SqliteHandle = { prepare: (sql: string) => { get: () => unknown }; close: () => void };

/** The tree the preflight still reads (the drill script beside it); no checkout is required. */
export type RepoRootAnswer = { root: string; error: string | null };

/** One `/proc/self/mountinfo` line for a mount point: the two fields that tell volume from bind. */
export type MountLine = { root: string; fstype: string; source: string };

export type VolumeJudgement = { ok: boolean; reason: string | null };

export type CheckAnswer = { verdict: 'pass' | 'fail'; evidence: string; failures: string[] };

/** One line, whitespace-flattened; `max` bounds it with an ellipsis. */
export function flat(value: unknown): string;
export function oneLine(value: unknown, max?: number): string;
export function reasonOf(error: unknown): string;
export function sha256(text: unknown): string;
export function ageOfMs(ms: number): string;

export function execDocker(args: string[]): Promise<DockerAnswer>;
export function openReadonlyDefault(file: string): Promise<SqliteHandle>;

export function callJson(options: {
  fetchImpl: FetchLike;
  url: URL;
  token: string;
  method?: string;
  body?: unknown;
  /** The whole call's budget; default 10 s. */
  timeoutMs?: number;
}): Promise<CallResult>;

export function parseMountInfos(text: string, mountPoint?: string): MountLine[];
export function parseMountInfo(text: string, mountPoint?: string): MountLine | null;
export function judgeVolume(mount: { root?: string; fstype?: string } | null, options?: { hostDataDir?: string }): VolumeJudgement;
export function resolveRepoRoot(root: string): RepoRootAnswer;

/** The two rows that read the host: the container facts and the backup/drill facts. */
export function checkRuntime(ctx: unknown): Promise<CheckAnswer>;
export function checkBackups(ctx: unknown): Promise<CheckAnswer>;
