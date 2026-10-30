import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '@book/shared';

import type { DockerCall, DoctorReport } from '../../bin/adminDoctor.mjs';

/**
 * BOOK-188 — the fixtures the doctor's tests run against: a `node:http` stand-in for the running
 * stack, a docker stub that answers the four `inspect`/`exec` forms the preflight asks for, and
 * scratch trees on `mkdtemp`. No Docker, no prod, no network: nothing here can reach a real
 * container, and the only real database is a backup copy that is opened read-only.
 */

export const TOKEN = 'doctor-token';
export const COMMIT = 'abc1234';
export const IMAGE = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
export const IMAGE_SHORT = '0123456789ab';
export const HOUR = 3_600_000;

/** The rows, in the order the contract fixes. */
export const IDS = ['runtime', 'schema', 'db_home', 'frame', 'reset_dry_run', 'graph', 'backups'];

export const READY_MOUNTINFO = [
  '22 1 254:1 / / rw,relatime - overlay overlay rw',
  '36 35 0:32 /docker/volumes/book-data/_data /data rw,relatime - btrfs /dev/vdb rw',
].join('\n');
/** The Mac's disk seen through the OrbStack VM — the bind BOOK-183 removes. */
export const BIND_MOUNTINFO = [
  '22 1 254:1 / / rw,relatime - overlay overlay rw',
  '36 35 0:32 /Users/tester/book-data /data rw,relatime master:1 - virtiofs data rw',
].join('\n');

const servers: Server[] = [];
const dirs: string[] = [];

/** Every stub and every temp dir a test made; call it from `afterEach`. */
export async function closeDoctors(): Promise<void> {
  for (const server of servers.splice(0)) {
    await new Promise<void>((done) => {
      server.close(() => {
        done();
      });
    });
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** The cwd of a spawned CLI: the newest scratch dir, so no test runs inside the checkout. */
export function scratchCwd(): string {
  return dirs[dirs.length - 1] ?? tmpdir();
}

/* ------------------------------------------------------------------------- the stack stub -- */

export type Answer = { status?: number; body: unknown };
export type Route = (request: IncomingMessage, body: string) => Answer;

export async function stubServer(routes: Record<string, Route>): Promise<{ base: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = new URL(request.url ?? '/', 'http://stub').pathname;
      const route = routes[path];
      if (route === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 'NOT_FOUND' }));
        return;
      }
      const answer = route(request, Buffer.concat(chunks).toString('utf8'));
      response.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the stub has no port');
  servers.push(server);
  return { base: `http://127.0.0.1:${String(address.port)}` };
}

export const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The route's answer, as the parallel server half will send it (the contract, not a file). */
export function doctorBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    build: { commit: COMMIT, version: '0.1.0' },
    schema: { userVersion: 23, expected: 23 },
    dumps: {
      preMigration: {
        file: '/data/backups/pre-v22-20261028T120000Z.db',
        mtimeMs: Date.now() - 2 * HOUR,
        bytes: 123_456,
        integrity: 'ok',
        userVersion: 22,
      },
    },
    dataDir: {
      path: '/data',
      entries: ['admin.token', 'book.db', 'book.db-wal'],
      denied: [] as string[],
      stray: [] as string[],
      tokens: { admin: true, engine: true },
    },
    frame: {
      source: 'basis',
      rows: [
        { chapter: 1, position: 'first', sha256: sha(FRAME_FIRST_SENTENCE) },
        { chapter: 42, position: 'last', sha256: sha(FRAME_LAST_SENTENCE) },
      ],
    },
    graph: { shipped: false },
    ...overrides,
  };
}

/**
 * BOOK-236 — a shipped stage-3 graph as `GET /api/admin/doctor` answers it, `writtenChapters`
 * included. The default is the state the launch reset leaves: nothing written, nothing graphed.
 */
export function graphBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { shipped: true, facts: 0, threads: 0, edges: 0, closureMs: null, writtenChapters: 0, ...overrides };
}

/** The reset dry-run report, as `reset book` already answers it. */
export function resetBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dryRun: true,
    tables: [
      { key: 'comments', label: 'comments', rows: 12 },
      { key: 'events', label: 'events', rows: 400 },
    ],
    total: 412,
    kept: [
      { key: 'identities', rows: 3 },
      { key: 'front_matter', rows: 1 },
    ],
    frame: { chapters: 2 },
    engine: { openSteps: 0, liveLeases: 0 },
    manuscript: { proseChapters: 0 },
    ...overrides,
  };
}

/** A whole healthy stack: `/healthz`, both admin answers and the two framed chapters. */
export function readyRoutes(
  body: Record<string, unknown> = doctorBody(),
  reset: Record<string, unknown> = resetBody(),
): Record<string, Route> {
  return {
    '/healthz': () => ({ body: { ok: true, commit: COMMIT } }),
    '/api/admin/doctor': () => ({ body }),
    '/api/admin/reset/book': () => ({ body: reset }),
    '/api/chapters/1': () => ({ body: { chapter: 1, blocks: [{ text: FRAME_FIRST_SENTENCE }] } }),
    '/api/chapters/42': () => ({ body: { chapter: 42, blocks: [{ text: FRAME_LAST_SENTENCE }] } }),
  };
}

/* ------------------------------------------------------------------------- the host stub -- */

export type DockerFacts = {
  states?: Record<string, { Running: boolean; Status?: string; health?: string }>;
  images?: Record<string, string>;
  label?: string;
  buildInfo?: string | null;
  mountinfo?: string;
};

export function dockerStub(facts: DockerFacts = {}): DockerCall {
  return async (args) => {
    const [verb, , format, name = ''] = args;
    if (verb === 'inspect' && format === '{{json .State}}') {
      const state = facts.states?.[name] ?? { Running: true, Status: 'running', health: 'healthy' };
      const payload: Record<string, unknown> = { Running: state.Running, Status: state.Status ?? 'running' };
      if (state.health !== undefined) payload.Health = { Status: state.health };
      return { code: 0, stdout: JSON.stringify(payload), stderr: '' };
    }
    if (verb === 'inspect' && format === '{{.Image}}') {
      return { code: 0, stdout: facts.images?.[name] ?? IMAGE, stderr: '' };
    }
    if (verb === 'inspect' && format === '{{index .Config.Labels "book.commit"}}') {
      return { code: 0, stdout: facts.label ?? COMMIT, stderr: '' };
    }
    if (verb === 'exec' && args[3] === '/app/build-info.json') {
      if (facts.buildInfo === null) return { code: 1, stdout: '', stderr: 'cat: /app/build-info.json: No such file' };
      return { code: 0, stdout: facts.buildInfo ?? JSON.stringify({ commit: COMMIT }), stderr: '' };
    }
    if (verb === 'exec' && args[3] === '/proc/self/mountinfo') {
      return { code: 0, stdout: facts.mountinfo ?? READY_MOUNTINFO, stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `No such object: ${args.join(' ')}` };
  };
}

/* --------------------------------------------------------------------------- the trees -- */

export function scratchRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-doctor-'));
  dirs.push(dir);
  return dir;
}

/** A working tree: the deploy scripts where the repository keeps them, plus the manuscript. */
export function makeRepo(
  root: string,
  manuscript: Record<string, string> = {},
  drill: 'site' | 'root' | 'none' = 'site',
): string {
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'manuscript'), { recursive: true });
  if (drill !== 'none') {
    const dir = drill === 'root' ? join(repo, 'deploy') : join(repo, 'site', 'deploy');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'restore-drill.sh'), '#!/usr/bin/env bash\n');
  }
  for (const [name, text] of Object.entries(manuscript)) writeFileSync(join(repo, 'manuscript', name), text);
  return repo;
}

/** A host backup that is a real database, aged by its mtime. */
export function makeHostBackup(backups: string, stamp: string, ageMs: number): string {
  const dir = join(backups, 'daily', stamp);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'book.db');
  const db = new Database(file);
  db.exec('CREATE TABLE chapters (n INTEGER PRIMARY KEY); INSERT INTO chapters (n) VALUES (1), (2);');
  db.close();
  const when = new Date(Date.now() - ageMs);
  utimesSync(file, when, when);
  return file;
}

export function utcStamp(ageMs: number): string {
  return new Date(Date.now() - ageMs).toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

export function writeLog(file: string, lines: string[]): string {
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

export const fetchLike = (input: string | URL, init?: RequestInit): Promise<Response> => fetch(input, init);

export function byId(report: DoctorReport, id: string): DoctorReport['checks'][number] {
  const found = report.checks.find((check) => check.id === id);
  if (found === undefined) throw new Error(`no check ${id}`);
  return found;
}

const SITE = resolve(import.meta.dirname, '..', '..');

export type CliResult = { status: number; stdout: string; stderr: string };

/**
 * `node bin/admin.mjs <args>` with exactly the environment a case names: no inherited token, no
 * data dir, no `BOOK_*` variable — the process half is proved by what the operator really runs.
 */
export function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  const child = spawn(process.execPath, [join(SITE, 'bin', 'admin.mjs'), ...args], {
    cwd: scratchCwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((done) => {
    child.on('close', (code) => {
      done({ status: code ?? 1, stdout, stderr });
    });
  });
}
