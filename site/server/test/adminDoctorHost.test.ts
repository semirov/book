import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FRAME_FIRST_SENTENCE } from '@book/shared';

import { callJson, judgeVolume, manuscriptProse, parseMountInfo, parseMountInfos, resolveRepoRoot } from '../../bin/adminDoctorHost.mjs';
import type { FetchLike } from '../../bin/adminDoctorHost.mjs';
import { BIND_MOUNTINFO, READY_MOUNTINFO } from './adminDoctorFixtures.ts';

/**
 * BOOK-188 — the readings the host module owns: the volume rule and the mountinfo lines, the
 * working-tree resolver, the manuscript-is-prose rule (a heading is a title, not prose — BOOK-32)
 * and the one HTTP call's budget, because a server that never answers must not hang a preflight.
 */

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repo whose `manuscript/` holds exactly these files. */
function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'book-doctor-host-'));
  dirs.push(root);
  mkdirSync(join(root, 'manuscript'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, 'manuscript', name), text);
  return root;
}

const fetchLike: FetchLike = (input, init) => fetch(input, init);

/** A local server on a free port; the test pushes it for teardown. */
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<URL> {
  const server = createServer(handler);
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the stub has no port');
  return new URL(`http://127.0.0.1:${String(address.port)}/api/admin/doctor`);
}

describe('the mountinfo lines and the volume rule', () => {
  it('reads every /data line, and the last one is the effective mount', () => {
    expect(parseMountInfo(READY_MOUNTINFO)).toEqual({ root: '/docker/volumes/book-data/_data', fstype: 'btrfs', source: '/dev/vdb' });
    expect(parseMountInfo(BIND_MOUNTINFO)).toEqual({ root: '/Users/tester/book-data', fstype: 'virtiofs', source: 'data' });
    // A volume first, a bind stacked over it later: the container sees the bind.
    const stacked = `${READY_MOUNTINFO}\n37 35 0:33 /Users/tester/book-data /data rw - virtiofs data rw`;
    expect(parseMountInfos(stacked).map((line) => line.fstype)).toEqual(['btrfs', 'virtiofs']);
    expect(parseMountInfo(stacked)?.fstype).toBe('virtiofs');
    expect(parseMountInfo('22 1 254:1 / / rw - overlay overlay rw')).toBeNull();
    expect(parseMountInfo('')).toBeNull();
  });

  it('accepts a volume root and refuses a bind, a host path and a plain host directory', () => {
    expect(judgeVolume({ root: '/docker/volumes/book-data/_data', fstype: 'btrfs' }).ok).toBe(true);
    expect(judgeVolume({ root: '/var/lib/docker/volumes/book-data/_data', fstype: 'ext4' }).ok).toBe(true);
    // The Mac's disk through a FUSE filesystem: a bind whatever the path says.
    expect(judgeVolume({ root: '/docker/volumes/x/_data', fstype: 'virtiofs' }).ok).toBe(false);
    expect(judgeVolume({ root: '/Users/tester/book-data', fstype: 'ext4' }).ok).toBe(false);
    expect(judgeVolume({ root: '/Volumes/Book/book-data', fstype: 'ext4' }).ok).toBe(false);
    expect(judgeVolume({ root: '/home/tester/book-data', fstype: 'ext4' }).ok).toBe(false);
    expect(judgeVolume({ root: '/srv/book-data/live', fstype: 'ext4' }, { hostDataDir: '/srv/book-data' }).ok).toBe(false);
    // A block filesystem outside a volume store is not a volume: the rule is positive.
    const plain = judgeVolume({ root: '/opt/book-data', fstype: 'ext4' });
    expect(plain.ok).toBe(false);
    expect(plain.reason).toBe('not a volume root: /opt/book-data (ext4) — BOOK-183');
  });
});

describe('resolveRepoRoot — a wrong root is not an empty tree', () => {
  it('believes a root with manuscript/ or .git, and names the one that has neither', () => {
    expect(resolveRepoRoot(repoWith({})).error).toBeNull();
    const bare = mkdtempSync(join(tmpdir(), 'book-doctor-noroot-'));
    dirs.push(bare);
    expect(resolveRepoRoot(bare)).toEqual({ root: bare, error: `BOOK_REPO_ROOT is not a book checkout: ${bare}` });
  });
});

describe('manuscriptProse — a chapter heading is a title, not prose', () => {
  it('passes a chapter that is a heading plus the frozen sentence', () => {
    expect(manuscriptProse(repoWith({ 'ch01.md': `Замечаний нет\n\n${FRAME_FIRST_SENTENCE}\n` }))).toEqual([]);
  });

  it('lists a chapter with one paragraph that is not the frame', () => {
    const repo = repoWith({ 'ch01.md': `Замечаний нет\n\n${FRAME_FIRST_SENTENCE}\n\nИ ещё один абзац.\n` });
    expect(manuscriptProse(repo)).toEqual(['ch01.md']);
  });

  it('lists a file that is not a chapter, and a tree with no manuscript holds none', () => {
    const front = repoWith({ '00-front.md': 'Книга без названия\n\nО чём эта книга.\n' });
    expect(manuscriptProse(front)).toEqual(['00-front.md']);
    expect(manuscriptProse(join(tmpdir(), 'book-doctor-no-such-tree'))).toEqual([]);
  });
});

describe('callJson — one request with a budget', () => {
  it('turns a server that never answers into a timeout', async () => {
    const url = await listen(() => {
      /* accepted, and deliberately never answered */
    });
    const answer = await callJson({ fetchImpl: fetchLike, url, token: 'token', timeoutMs: 30 });
    expect('error' in answer ? answer.error : 'no error').toContain('timeout after 30 ms');
    expect('error' in answer ? answer.error : '').toContain(url.origin);
  });

  it('answers a 200 JSON body with its status, its ok and its body', async () => {
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, commit: 'abc1234' }));
    });
    const answer = await callJson({ fetchImpl: fetchLike, url, token: 'token' });
    expect(answer).toEqual({ status: 200, ok: true, body: { ok: true, commit: 'abc1234' } });
  });
});
