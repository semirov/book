#!/usr/bin/env node
/**
 * scripts/orphan-check.mjs — BOOK-81: no test worker outlives its run.
 *
 * Run after a suite (or after a run that was killed): a leaked `node (vitest N)` is printed and
 * sets the exit code, so an agent can prove its own run left the machine clean.
 *
 *     npm run check:orphans     # 0 clean · 1 leaked · 2 the table could not be read or believed
 *
 * Exit 2 is the honest answer to "I cannot tell": `ps` missing or failing, or a node process
 * naming vitest in a title this check does not know (a retitled worker on another host). What
 * counts and why it is the parent link — `scripts/lib/orphans.mjs`. Deliberately not part of
 * `verify`: this reads the host's process table, which a CI container need not have, and answers
 * a question about the host rather than about the code.
 */

import { execFileSync } from 'node:child_process';

import { testProcesses, unrecognised } from './lib/orphans.mjs';

/** The exit code, rather than a call that would cut the output short. */
function check() {
  let table;
  try {
    table = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,etime=,command='], { encoding: 'utf8' });
  } catch (error) {
    const reason = (error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown');
    console.error(`orphan-check: cannot read the process table — ps failed (${reason})`);
    return 2;
  }

  const stranger = unrecognised(table);
  if (stranger.length > 0) {
    for (const entry of stranger) console.error(`unknown vitest shape pid ${String(entry.pid)} — ${entry.command}`);
    console.error('orphan-check: vitest is running under titles this check does not know; the machine cannot be called clean');
    return 2;
  }

  const found = testProcesses(table);
  if (found.length === 0) {
    console.log('orphan-check: no vitest process in the table — nothing is running, nothing leaked');
    return 0;
  }

  for (const entry of found) {
    const who = entry.live
      ? 'live parent'
      : entry.ppid === 1
        ? 'parent 1 (leaked)'
        : `no vitest parent, ppid ${String(entry.ppid)} (leaked)`;
    console.log(`test process pid ${String(entry.pid)} — ${String(entry.mb)} MB, ${entry.etime}, ${who}`);
  }

  const leaked = found.filter((entry) => !entry.live);
  if (leaked.length > 0) {
    console.error(`orphan-check: ${String(leaked.length)} leaked test process(es); a killed run must leave none`);
    return 1;
  }

  console.log(`orphan-check: ok — ${String(found.length)} test process(es), every one with a live parent`);
  return 0;
}

process.exitCode = check();
