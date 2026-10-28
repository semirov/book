/**
 * BOOK-81: the pool that makes a killed run harmless, and `scripts/lib/orphans.mjs`, the
 * judgement behind `npm run check:orphans`.
 *
 * The check reads the host's process table, so the host is what the test hands it: rows in the
 * shape `ps -eo pid=,ppid=,rss=,etime=,command=` really prints, a title with spaces and all.
 * What is asserted is the rule the issue asks for — a worker is a leak only when the parent that
 * would wait for it is gone, never because it is old, heavy or slow — plus the two shapes that
 * must not slip past: a parent that exists but is not vitest, and a title nobody recognises.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readTable, testProcesses, unrecognised } from '../../scripts/lib/orphans.mjs';

const SITE = resolve(import.meta.dirname, '..', '..');

/** One row of the table, as `ps` prints it: `pid ppid rss etime command`. */
const row = (pid: number, ppid: number, kb: number, etime: string, command: string): string =>
  `${String(pid)} ${String(ppid)} ${String(kb)} ${etime} ${command}`;

const PS = [
  row(1, 0, 23552, '31-11:40:23', '/sbin/launchd'),
  row(4021, 1, 14000, '02:11', '/usr/sbin/cfprefsd daemon'),
  row(62300, 4001, 9000, '00:20', '/bin/zsh -c npm run test'),
  row(62549, 4001, 12000, '00:09', 'npm run test'),
  row(62554, 62549, 170272, '00:06', 'node (vitest)'),
  row(62560, 62554, 75648, '00:03', 'node (vitest 3)'),
  row(62561, 1, 315408, '00:04', 'node (vitest 4)'),
  row(63367, 62300, 342544, '00:02', 'node (vitest 1)'),
  row(63370, 62554, 102400, '00:02', 'node (vitest 5)'),
  row(63390, 1, 50000, '00:05', 'node (vitest 9)'),
  row(63391, 1, 90000, '01:00', 'node (vitest)'),
  row(64000, 1, 24000, '01:00', 'node server/dist/index.js'),
  // A main started by path rather than title, and a worker of it: the live shape without a title.
  row(64400, 4001, 42000, '00:01', 'node node_modules/vitest/vitest.mjs run'),
  row(64410, 64400, 80000, '00:01', 'node (vitest 2)'),
  // A child whose parent is not in the table at all (a reaper, a pid reused, a vanished shell).
  row(65000, 64999, 60000, '00:30', 'node (vitest 6)'),
].join('\n');

describe('orphan-check — the pool is pinned and the parent is the evidence (BOOK-81)', () => {
  it('keeps the pool that cannot leak: a revert to forks turns this red', () => {
    const config = readFileSync(join(SITE, 'vitest.config.ts'), 'utf8');

    // The rationale and the measured numbers live in the config; here only the decision is pinned.
    expect(config).toMatch(/pool: 'threads'/u);
  });

  it('reads a ps table: numbers, then a title that may hold spaces', () => {
    const processes = readTable(PS);

    expect(processes.size).toBe(15);
    expect(processes.get(62554)).toEqual({ ppid: 62549, rss: 170272, etime: '00:06', command: 'node (vitest)' });
    expect(processes.get(4021)?.command).toBe('/usr/sbin/cfprefsd daemon');
    expect(readTable('  not a row\n\n').size).toBe(0);
  });

  it('calls a worker live while its vitest parent is there, and a leak once it is not', () => {
    const found = new Map(testProcesses(PS).map((entry) => [entry.pid, entry]));

    // Workers of a live suite: parents 62554 (`node (vitest)`) and 64400 (`…/vitest.mjs run`).
    expect(found.get(62560)).toMatchObject({ ppid: 62554, mb: 74, live: true });
    expect(found.get(63370)).toMatchObject({ live: true });
    expect(found.get(64410)).toMatchObject({ ppid: 64400, live: true });
    // Parent 1 — the shape the issue counted: the runner is gone, the worker is not.
    expect(found.get(62561)).toMatchObject({ ppid: 1, mb: 308, live: false });
    expect(found.get(63390)).toMatchObject({ live: false });
    // A parent that exists but is not vitest (an agent's shell): still nobody waiting for the worker.
    expect(found.get(63367)).toMatchObject({ ppid: 62300, live: false });
    // A parent that is not in the table at all (a reaper reparented it): no live parent either.
    expect(found.get(65000)).toMatchObject({ ppid: 64999, live: false });
    // The bare main is a leak only when nothing at all is above it.
    expect(found.get(63391)).toMatchObject({ live: false });
    expect(found.get(62554)).toMatchObject({ ppid: 62549, live: true });
  });

  it('ignores every process that is not a vitest runner', () => {
    const pids = testProcesses(PS).map((entry) => entry.pid);

    expect(pids).toEqual([62554, 62560, 62561, 63367, 63370, 63390, 63391, 64410, 65000]);
  });

  it('names a node process that mentions vitest in a shape it does not know — and only that', () => {
    const table = [
      row(80001, 1, 80000, '00:03', 'node (vitest worker 3)'),
      row(80002, 4001, 9000, '00:03', 'vim vitest.config.ts'),
      row(80003, 4001, 9000, '00:03', 'node -e process.title="node (vitest 7)"'),
      row(62554, 62549, 170272, '00:06', 'node (vitest)'),
      row(64400, 4001, 42000, '00:01', 'node node_modules/vitest/vitest.mjs run'),
      row(64000, 1, 24000, '01:00', 'node server/dist/index.js'),
    ].join('\n');

    // `-e` with the title is not a vitest process, and an editor's filename is not a process of ours.
    expect(unrecognised(table)).toEqual([{ pid: 80001, command: 'node (vitest worker 3)' }]);
  });
});
