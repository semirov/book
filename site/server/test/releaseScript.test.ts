/**
 * BOOK-119 — `scripts/release.mjs`, driven as functions (no shell, no git).
 *
 * The layout is the contract the server and the deploy depend on: `releases/<id>/` is immutable,
 * `current` is a **relative** symlink swapped by rename, and a prune never removes the release
 * `current` names or the one `.state/last-good-release` records. The first publish on a flat
 * `dist` adopts it instead of deleting the shell an open tab still asks for.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  adoptLegacy,
  currentReleaseId,
  listReleases,
  publish,
  readLastGoodRelease,
  swap,
  writeLastGoodRelease,
} from '../../scripts/release.mjs';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-release-script-'));
  dirs.push(dir);
  return dir;
}

/** A build as Vite leaves it in `dist/staging`. */
function stage(webDist: string, asset = 'index-abc123.js', body = 'console.log("build");\n'): void {
  mkdirSync(join(webDist, 'staging', 'assets'), { recursive: true });
  writeFileSync(join(webDist, 'staging', 'index.html'), `<!doctype html><script type="module" src="/assets/${asset}"></script>`, 'utf8');
  writeFileSync(join(webDist, 'staging', 'assets', asset), body, 'utf8');
  writeFileSync(join(webDist, 'staging', 'theme.js'), 'document.documentElement.dataset.theme = "day";', 'utf8');
}

function publishAt(webDist: string, stateDir: string, offsetMs: number, sha = 'aaaaaaa') {
  return publish({ webDist, stateDir, sha, now: new Date(Date.UTC(2026, 9, 27, 12, 0, 0) + offsetMs), log: () => {} });
}

/** The release directories — `.manifests` is the index beside them, not a release. */
function releaseIds(webDist: string): string[] {
  return readdirSync(join(webDist, 'releases'))
    .filter((name) => !name.startsWith('.'))
    .sort();
}

/** The retained manifest ids, from `releases/.manifests/<id>.json`. */
function manifestIds(webDist: string): string[] {
  try {
    return readdirSync(join(webDist, 'releases', '.manifests'))
      .map((name) => name.replace(/\.json$/u, ''))
      .sort();
  } catch {
    return [];
  }
}

describe('publish', () => {
  it('renames staging into releases/<sha7>-<stamp>, writes the manifest outside the tree, swaps current', () => {
    const webDist = temp();
    stage(webDist);
    const result = publishAt(webDist, join(webDist, 'state'), 0);

    expect(result.created).toBe(true);
    expect(result.id).toMatch(/^aaaaaaa-\d{8}T\d{6}Z$/u);
    const dir = join(webDist, 'releases', result.id);
    expect(existsSync(join(dir, 'index.html'))).toBe(true);
    expect(existsSync(join(webDist, 'staging'))).toBe(false);

    // The manifest sits beside the releases, never inside one: `releases/<id>` is a served root,
    // and a `release.json` in there answers `GET /release.json` with the sha and the counts.
    expect(existsSync(join(dir, 'release.json'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(webDist, 'releases', '.manifests', `${result.id}.json`), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest).toMatchObject({ id: result.id, sha: 'aaaaaaa', publishedAt: '2026-10-27T12:00:00.000Z' });
    expect(manifest.files).toBe(3);
    expect(Number(manifest.bytes)).toBeGreaterThan(0);
    expect(typeof manifest.stamp).toBe('string');

    const link = join(webDist, 'current');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join('releases', result.id));
    expect(currentReleaseId(webDist)).toBe(result.id);

    // No temp link survives the rename.
    expect(readdirSync(webDist).filter((name) => name.startsWith('.current-'))).toEqual([]);
    // `.manifests` sits in `releases/` and is the index, not a release.
    expect(listReleases(webDist).map((release) => release.id)).toEqual([result.id]);
  });

  it('adopts a flat dist before the first swap, so the unguarded shell keeps its files', () => {
    const webDist = temp();
    mkdirSync(join(webDist, 'assets'), { recursive: true });
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>legacy</title>', 'utf8');
    writeFileSync(join(webDist, 'theme.js'), 'legacy theme', 'utf8');
    writeFileSync(join(webDist, 'assets', 'index-OLD.js'), 'old bundle', 'utf8');
    stage(webDist, 'index-new.js');

    const adopted = adoptLegacy(webDist, new Date('2026-10-27T11:00:00Z'));
    expect(adopted).toBe('legacy-20261027T110000Z');
    expect(existsSync(join(webDist, 'index.html'))).toBe(false);
    const legacy = join(webDist, 'releases', adopted ?? '');
    expect(readFileSync(join(legacy, 'assets', 'index-OLD.js'), 'utf8')).toBe('old bundle');
    expect(readFileSync(join(legacy, 'theme.js'), 'utf8')).toBe('legacy theme');
    // Its manifest goes where every manifest goes: outside the served tree.
    expect(existsSync(join(legacy, 'release.json'))).toBe(false);
    expect(manifestIds(webDist)).toEqual(['legacy-20261027T110000Z']);

    // Publishing after the adoption keeps the legacy release as an older retained one.
    const result = publishAt(webDist, join(webDist, 'state'), 0);
    expect(result.created).toBe(true);
    expect(releaseIds(webDist)).toContain('legacy-20261027T110000Z');
    expect(currentReleaseId(webDist)).toBe(result.id);
  });

  it('is idempotent: a second publish with no staging leaves the same release current', () => {
    const webDist = temp();
    stage(webDist);
    const first = publishAt(webDist, join(webDist, 'state'), 0);
    const second = publishAt(webDist, join(webDist, 'state'), 5000);
    expect(second).toMatchObject({ id: first.id, created: false, pruned: [] });
    expect(releaseIds(webDist)).toEqual([first.id]);
    expect(currentReleaseId(webDist)).toBe(first.id);
  });

  it('never overwrites a live release published in the same second', () => {
    const webDist = temp();
    const stateDir = join(webDist, 'state');
    stage(webDist, 'index-first.js', 'first\n');
    const first = publishAt(webDist, stateDir, 0);
    stage(webDist, 'index-second.js', 'second\n');
    const second = publishAt(webDist, stateDir, 0); // same `now`, different bytes
    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(releaseIds(webDist)).toEqual([first.id, second.id].sort());
    expect(readFileSync(join(webDist, 'releases', first.id, 'assets', 'index-first.js'), 'utf8')).toBe('first\n');
  });

  it('never publishes a failed build: no staging, no current, nothing created', () => {
    const webDist = temp();
    mkdirSync(join(webDist, 'staging'), { recursive: true }); // a build that died before index.html
    expect(() => publishAt(webDist, join(webDist, 'state'), 0)).toThrow(/no build/u);
    expect(existsSync(join(webDist, 'current'))).toBe(false);
    expect(existsSync(join(webDist, 'releases'))).toBe(true);
    expect(releaseIds(webDist)).toEqual([]);
  });

  it('keeps three releases, oldest by publishedAt, and prints what it pruned', () => {
    const webDist = temp();
    const stateDir = join(webDist, 'state');
    const made = [];
    for (let index = 0; index < 5; index += 1) {
      stage(webDist, `index-${index}.js`, `body ${index}\n`);
      const result = publishAt(webDist, stateDir, index * 1000);
      made.push(result.id);
      if (index >= 3) expect(result.pruned).toHaveLength(1);
    }
    expect(releaseIds(webDist)).toEqual(made.slice(2).sort());
    expect(currentReleaseId(webDist)).toBe(made[4]);
    expect(listReleases(webDist).map((release) => release.id)).toEqual([...made.slice(2)].reverse());
    // A pruned release takes its manifest with it — the index does not outgrow the store.
    expect(manifestIds(webDist)).toEqual(made.slice(2).sort());
  });

  it('never prunes current or the release .state/last-good-release records', () => {
    const webDist = temp();
    const stateDir = join(webDist, 'state');
    const made = [];
    for (let index = 0; index < 5; index += 1) {
      stage(webDist, `index-${index}.js`, `body ${index}\n`);
      const result = publishAt(webDist, stateDir, index * 1000);
      made.push(result.id);
      // The second release is the last known good one, and would be oldest-but-two.
      if (index === 1) writeLastGoodRelease(result.id, stateDir);
    }
    expect(readLastGoodRelease(stateDir)).toBe(made[1]);
    const kept = releaseIds(webDist);
    expect(kept).toContain(made[1]);
    expect(kept).toContain(made[4]);
    expect(kept).not.toContain(made[0]);
    // Current plus last good plus the newest three: one more than `keep`, by design.
    expect(kept).toHaveLength(4);
    expect(manifestIds(webDist)).toHaveLength(4);
  });
});

describe('swap', () => {
  it('points current at a release already on disk — the red path makes disk agree with the process', () => {
    const webDist = temp();
    const stateDir = join(webDist, 'state');
    stage(webDist, 'index-a.js', 'a\n');
    const first = publishAt(webDist, stateDir, 0);
    stage(webDist, 'index-b.js', 'b\n');
    const second = publishAt(webDist, stateDir, 1000);
    expect(currentReleaseId(webDist)).toBe(second.id);

    swap({ webDist, id: first.id });
    expect(currentReleaseId(webDist)).toBe(first.id);
    // A swap is a link, not a copy or a move: the release it left is still whole for a reader.
    expect(readFileSync(join(webDist, 'releases', second.id, 'assets', 'index-b.js'), 'utf8')).toBe('b\n');
  });

  it('refuses a release that is not there, and leaves current alone', () => {
    const webDist = temp();
    const stateDir = join(webDist, 'state');
    stage(webDist);
    const only = publishAt(webDist, stateDir, 0);
    expect(() => swap({ webDist, id: 'gone-20260101T000000Z' })).toThrow(/no release/u);
    expect(() => swap({ webDist, id: '' })).toThrow(/--id/u);
    expect(currentReleaseId(webDist)).toBe(only.id);
  });
});
