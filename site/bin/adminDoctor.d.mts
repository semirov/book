/**
 * Types for `bin/adminDoctor.mjs` (BOOK-188), so the CLI tests can drive the preflight in
 * process with injected seams and read the report it returns.
 */

export type DoctorVerdict = 'pass' | 'fail' | 'not_shipped';

export type DoctorCheck = {
  id: string;
  label: string;
  verdict: DoctorVerdict;
  evidence: string;
  failures: string[];
};

export type DoctorReport = { ok: boolean; exitCode: number; at: string; checks: DoctorCheck[] };

export type ParsedDoctor = { kind: 'doctor'; json: boolean; url?: string };

/** `docker <args>` — one call, both halves of a refusal visible. */
export type DockerAnswer = { code: number; stdout: string; stderr: string };
export type DockerCall = (args: string[]) => Promise<DockerAnswer>;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** A read-only sqlite handle: the one method the doctor needs, plus `close`. */
export type SqliteHandle = { prepare: (sql: string) => { get: () => unknown }; close: () => void };

export type DoctorOptions = {
  /** Already validated by the caller (`assertLocalTarget`). */
  target: URL;
  /** Already resolved by the caller (`resolveAdminToken`); the doctor never looks a token up. */
  token?: string;
  repoRoot?: string;
  backupRoot?: string;
  drillLog?: string;
  docker?: DockerCall;
  fetchImpl?: FetchLike;
  now?: () => number;
  openReadonly?: (file: string) => Promise<SqliteHandle> | SqliteHandle;
};

export function parseDoctorArgs(argv: string[]): ParsedDoctor | { kind: 'help' };
export function runDoctor(options: DoctorOptions): Promise<DoctorReport>;
export function printDoctorReport(report: DoctorReport, options?: { json?: boolean }): void;
