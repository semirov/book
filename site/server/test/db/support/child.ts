/**
 * BOOK-175 — the child-process plumbing the database tests need, in one place.
 *
 * Production runs four writer *processes* on one `book.db`, so the honest test spawns processes:
 * two in-process handles share a page cache and a WAL index, and would agree with each other in
 * ways two processes never do. Each fixture writes one JSON object per line on stdout, and
 * `next()` is the handshake — a test never synchronises on a timer, so there is no window that a
 * loaded machine turns into a flake, and no sleep that a fast machine turns into a lie.
 *
 * Ordering detail that matters: a fixture's last stdout line can arrive *after* the `exit` event,
 * so a pending handshake is rejected on `close` (all stdio drained), not on `exit`.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export type ChildEvent = Record<string, unknown>;
export type ExitInfo = { code: number | null; signal: NodeJS.Signals | null };

export type FixtureChild = {
  pid: number;
  /** Everything the fixture emitted, in order — the evidence a test reports on. */
  events: ChildEvent[];
  /** Everything it wrote to stderr: a fixture that dies before its handshake explains itself here. */
  stderr: () => string;
  /** The first event matching `match`, whether it arrived before the ask or after it. */
  next: (match: (event: ChildEvent) => boolean) => Promise<ChildEvent>;
  /** Resolves on `exit`, so a test can assert the signal it was killed with. */
  exited: Promise<ExitInfo>;
  alive: () => boolean;
  /** SIGKILL by default, then the exit event. Never leaves a live child behind. */
  kill: (signal?: NodeJS.Signals) => Promise<ExitInfo>;
};

/** The fixtures sit next to the tests that spawn them, so a rename cannot drift. */
const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

export function spawnFixture(script: string, args: string[]): FixtureChild {
  const child = spawn(process.execPath, [join(FIXTURES, script), ...args]);
  const pid = child.pid;
  if (pid === undefined) throw new Error(`fixture ${script} did not start`);

  const events: ChildEvent[] = [];
  const waiting: Array<{
    match: (event: ChildEvent) => boolean;
    resolve: (event: ChildEvent) => void;
    reject: (error: Error) => void;
  }> = [];
  let stderr = '';
  /** Set once stdio is drained: an ask that arrives later can never be answered. */
  let closed: ExitInfo | null = null;

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exited = new Promise<ExitInfo>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
    child.on('error', (error) => {
      // A failed spawn has no `exit`; report it through the path a test already checks.
      for (const waiter of waiting.splice(0)) waiter.reject(error);
      resolve({ code: null, signal: null });
    });
  });

  createInterface({ input: child.stdout }).on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let event: ChildEvent;
    try {
      event = JSON.parse(trimmed) as ChildEvent;
    } catch {
      // A fixture killed mid-write can leave half a line. It is recorded, never guessed at: a
      // test only matches what it asked for, so this cannot stand in for a real handshake.
      event = { event: 'unparseable', line: trimmed };
    }
    events.push(event);
    const index = waiting.findIndex((waiter) => waiter.match(event));
    if (index < 0) return;
    const [waiter] = waiting.splice(index, 1);
    waiter?.resolve(event);
  });

  const death = (exit: ExitInfo): Error =>
    new Error(
      `fixture ${script} (pid ${String(pid)}) closed code=${String(exit.code)} signal=${String(exit.signal)} ` +
        `without the awaited handshake; stderr: ${stderr.trim() || '(empty)'}`,
    );

  child.on('close', (code, signal) => {
    // `close`, not `exit`: by now every line the fixture wrote has been delivered.
    closed = { code, signal };
    for (const waiter of waiting.splice(0)) waiter.reject(death(closed));
  });

  return {
    pid,
    events,
    stderr: () => stderr,
    next: (match) => {
      const seen = events.find(match);
      if (seen !== undefined) return Promise.resolve(seen);
      // Asking a fixture that is already gone must fail now, with its stderr — not hang until the
      // test times out and report the wrong thing.
      if (closed !== null) return Promise.reject(death(closed));
      return new Promise<ChildEvent>((resolve, reject) => waiting.push({ match, resolve, reject }));
    },
    exited,
    alive: () => child.exitCode === null && child.signalCode === null,
    kill: async (signal: NodeJS.Signals = 'SIGKILL') => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      return exited;
    },
  };
}
