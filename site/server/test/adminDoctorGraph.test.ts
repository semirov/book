import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runDoctor, type DoctorReport } from '../../bin/adminDoctor.mjs';
import {
  HOUR,
  TOKEN,
  byId,
  closeDoctors,
  dockerStub,
  doctorBody,
  fetchLike,
  graphBody,
  makeHostBackup,
  makeRepo,
  readyRoutes,
  resetBody,
  scratchRoot,
  stubServer,
  utcStamp,
  writeLog,
} from './adminDoctorFixtures.ts';

/**
 * BOOK-236 — the `graph` row, and the contract it changed.
 *
 * The preflight is run **right after the launch reset**: the book holds one written chapter (ch01)
 * and stage 3 has filed nothing yet, so there are no dependencies by construction (measured on
 * prod: `facts 20 · threads 1 · edges 0`, one written chapter — a one-chapter book has facts and
 * threads, but an edge needs two things pointing at each other). That state used to be `fail` for
 * ever — a gate that can never be green is a gate nobody reads. Now a dependency-free graph over a
 * book with at most one written chapter is `pass` (and says so, with the counts), a graph over a
 * book with two or more written chapters keeps the old rule, and an answer without the count keeps
 * the stricter rule too: an unknown is not a fresh book.
 */

afterEach(async () => {
  await closeDoctors();
});

/** A run where every row but `graph` is healthy, so a non-zero exit is the graph's own. */
async function reportWithGraph(graph: Record<string, unknown>): Promise<DoctorReport> {
  const root = scratchRoot();
  const repo = makeRepo(root, {}, 'site');
  const backups = join(root, 'backups');
  makeHostBackup(backups, '20261028T060000', HOUR);
  const log = writeLog(join(root, 'book-backup.log'), [`${utcStamp(HOUR)} level=info job=book-backup-drill status=ok`]);
  const body = doctorBody({ graph });
  const stack = await stubServer(readyRoutes(body, resetBody()));
  return runDoctor({
    target: new URL(stack.base),
    token: TOKEN,
    repoRoot: repo,
    backupRoot: backups,
    drillLog: log,
    docker: dockerStub(),
    fetchImpl: fetchLike,
  });
}

describe('doctor — the graph row tells a fresh book from a broken one (BOOK-236)', () => {
  it('passes a dependency-free graph on a book with one written chapter — that is the launch reset', async () => {
    // The prod shape after the launch reset: one written chapter, facts and threads already filed,
    // no edge yet. It used to fail on «no edges (0)» for ever.
    const fresh = await reportWithGraph(graphBody({ facts: 20, threads: 1, edges: 0, writtenChapters: 1 }));
    expect(fresh.exitCode).toBe(0);
    const graph = byId(fresh, 'graph');
    expect(graph.verdict).toBe('pass');
    expect(graph.evidence).toBe('no dependencies yet (1 written chapter · facts 20 · threads 1)');
    expect(graph.failures).toEqual([]);

    const reset = await reportWithGraph(graphBody({ writtenChapters: 0 }));
    expect(reset.exitCode).toBe(0);
    expect(byId(reset, 'graph').evidence).toBe('no dependencies yet (0 written chapters · facts 0 · threads 0)');
  });

  it('passes a dependency-free graph whether or not the nested counts are zero (BOOK-236 review)', async () => {
    // `facts:false`/`threads:''` are a payload that did not answer: strict zero on `edges` is the
    // fresh test, and the other two need only be readable numbers.
    const noFacts = await reportWithGraph(graphBody({ facts: 0, threads: 0, edges: 0, writtenChapters: 1 }));
    expect(byId(noFacts, 'graph').verdict).toBe('pass');
    expect(byId(noFacts, 'graph').evidence).toBe('no dependencies yet (1 written chapter · facts 0 · threads 0)');

    const unreadable = await reportWithGraph(graphBody({ facts: null, threads: 1, edges: 0, writtenChapters: 1 }));
    expect(byId(unreadable, 'graph').verdict).toBe('fail');
    expect(unreadable.exitCode).toBe(1);
  });

  it('passes a book with dependencies, one chapter or many, and carries the counts', async () => {
    const edges = await reportWithGraph(graphBody({ facts: 20, threads: 1, edges: 3, closureMs: 4, writtenChapters: 1 }));
    expect(byId(edges, 'graph').verdict).toBe('pass');
    expect(byId(edges, 'graph').evidence).toBe('facts 20 · threads 1 · edges 3 · written 1 chapter · closure 4 ms');
  });

  it('fails a one-chapter book whose edge count could not be read', async () => {
    // Strict zero on `edges` only: `null` is a payload that did not answer, not an empty graph.
    const unreadable = await reportWithGraph(graphBody({ facts: 20, threads: 1, edges: null, writtenChapters: 1 }));
    expect(byId(unreadable, 'graph').verdict).toBe('fail');
    expect(unreadable.exitCode).toBe(1);
    expect(byId(unreadable, 'graph').failures.join(' ')).toContain('the graph has no edges (0), while 1 chapter is written');
  });

  it('fails an empty graph once a second chapter is written, and names the count', async () => {
    const broken = await reportWithGraph(graphBody({ writtenChapters: 3 }));
    expect(broken.exitCode).toBe(1);
    expect(byId(broken, 'graph').verdict).toBe('fail');
    const named = byId(broken, 'graph').failures.join(' ');
    expect(named).toContain('the graph has no facts (0), while 3 chapters are written');
    expect(named).toContain('the graph has no edges (0), while 3 chapters are written');
  });

  it('does not read an unreadable count as an empty graph (BOOK-236 review)', async () => {
    // `Number(null) === 0`: the first cut called `{facts:null, threads:null, edges:null}` an empty
    // graph and passed it. A payload that could not count is not a book with nothing to count.
    const unreadable = await reportWithGraph(graphBody({ facts: null, threads: null, edges: null, writtenChapters: 0 }));
    expect(byId(unreadable, 'graph').verdict).toBe('fail');
    expect(unreadable.exitCode).toBe(1);
    expect(byId(unreadable, 'graph').failures[0]).toContain('the graph has no facts (0)');
  });

  it('fails a fresh book whose closure is measured above the limit', async () => {
    // A fresh book has no target to walk, so `closureMs: null` is its state — but a number over the
    // limit is a defect wherever it is found, and it used to be swallowed by the fresh branch.
    const slow = await reportWithGraph(graphBody({ writtenChapters: 1, closureMs: 120 }));
    expect(byId(slow, 'graph').verdict).toBe('fail');
    expect(slow.exitCode).toBe(1);
    expect(byId(slow, 'graph').evidence).toContain('120 ms');
    expect(byId(slow, 'graph').failures.join(' ')).toContain('limit 50 ms');
  });

  it('keeps the stricter rule when the answer carries no count, because an unknown is not fresh', async () => {
    const unknown = await reportWithGraph({ shipped: true, facts: 0, threads: 0, edges: 0, closureMs: null });
    expect(byId(unknown, 'graph').verdict).toBe('fail');
    expect(byId(unknown, 'graph').failures[0]).toBe('the graph has no facts (0)');

    const nulled = await reportWithGraph(graphBody({ writtenChapters: null }));
    expect(byId(nulled, 'graph').verdict).toBe('fail');
    expect(byId(nulled, 'graph').failures[0]).toBe('the graph has no facts (0)');
  });

  it('passes a populated graph and carries the count in its evidence', async () => {
    const fine = await reportWithGraph(graphBody({ facts: 4, threads: 2, edges: 9, closureMs: 7, writtenChapters: 3 }));
    expect(byId(fine, 'graph').verdict).toBe('pass');
    expect(byId(fine, 'graph').evidence).toBe('facts 4 · threads 2 · edges 9 · written 3 chapters · closure 7 ms');

    const one = await reportWithGraph(graphBody({ facts: 4, threads: 2, edges: 9, closureMs: 7, writtenChapters: 1 }));
    expect(byId(one, 'graph').verdict).toBe('pass');
    expect(byId(one, 'graph').evidence).toBe('facts 4 · threads 2 · edges 9 · written 1 chapter · closure 7 ms');
  });

  it('fails a written book’s graph when a count is zero or the closure is slow', async () => {
    const empty = await reportWithGraph(graphBody({ facts: 0, threads: 5, edges: 9, closureMs: 120, writtenChapters: 3 }));
    expect(byId(empty, 'graph').verdict).toBe('fail');
    const named = byId(empty, 'graph').failures.join(' ');
    expect(named).toContain('no facts (0)');
    expect(named).toContain('120 ms');

    const singular = await reportWithGraph(graphBody({ facts: 3, threads: 0, edges: 5, closureMs: 4, writtenChapters: 1 }));
    expect(byId(singular, 'graph').verdict).toBe('fail');
    expect(byId(singular, 'graph').failures.join(' ')).toContain('the graph has no threads (0), while 1 chapter is written');
  });

  it('keeps the not-shipped warning a warning, whatever the count', async () => {
    const absent = await reportWithGraph({ shipped: false });
    expect(byId(absent, 'graph').verdict).toBe('not_shipped');
    expect(absent.exitCode).toBe(0);
  });
});
