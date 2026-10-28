import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '@book/shared';

import { judgeVolume, parseDoctorArgs, parseMountInfo, printDoctorReport, runDoctor } from '../../bin/adminDoctor.mjs';
import type { DockerCall, DoctorReport } from '../../bin/adminDoctor.mjs';
import {
  BIND_MOUNTINFO,
  COMMIT,
  HOUR,
  IDS,
  IMAGE_SHORT,
  READY_MOUNTINFO,
  TOKEN,
  byId,
  closeDoctors,
  dockerStub,
  doctorBody,
  fetchLike,
  makeHostBackup,
  makeRepo,
  readyRoutes,
  resetBody,
  runCli,
  scratchRoot,
  sha,
  stubServer,
  utcStamp,
  writeLog,
  type Route,
} from './adminDoctorFixtures.ts';

/**
 * BOOK-188 — `node bin/admin.mjs doctor`. What is proved is the host's half: the eight rows and
 * their order, the exit code an operator scripts against, and the evidence a reader sees. No
 * Docker, no prod, no network: docker and the stack are stubs, every dir is a `mkdtemp` — except
 * the sqlite dump, a real file opened read-only, because "the backup opens" is the claim.
 */

afterEach(async () => {
  await closeDoctors();
});

/* ------------------------------------------------------------------------------- arguments -- */

describe('doctor — the arguments it accepts', () => {
  it('parses --json, --url, --url= and --help, and nothing else', () => {
    expect(parseDoctorArgs(['doctor'])).toEqual({ kind: 'doctor', json: false });
    expect(parseDoctorArgs(['doctor', '--json'])).toEqual({ kind: 'doctor', json: true });
    expect(parseDoctorArgs(['doctor', '--url', 'http://127.0.0.1:8091'])).toEqual({ kind: 'doctor', json: false, url: 'http://127.0.0.1:8091' });
    expect(parseDoctorArgs(['doctor', '--json', '--url=http://127.0.0.1:8091'])).toEqual({ kind: 'doctor', json: true, url: 'http://127.0.0.1:8091' });
    expect(parseDoctorArgs(['doctor', '--help'])).toEqual({ kind: 'help' });
    expect(parseDoctorArgs(['doctor', '-h'])).toEqual({ kind: 'help' });
  });

  it('rejects junk instead of guessing', () => {
    for (const argv of [[], ['reset', 'book'], ['doctor', '--json=1'], ['doctor', '--bogus'], ['doctor', 'extra'], ['doctor', '--url'], ['doctor', '--url='], ['doctor', '--url', '--json']]) {
      expect(() => parseDoctorArgs(argv), argv.join(' ')).toThrow();
    }
  });
});

/* ---------------------------------------------------------------------------- host readers -- */

describe('doctor — the volume rule and the mountinfo line', () => {
  it('reads the /data line and nothing else', () => {
    expect(parseMountInfo(READY_MOUNTINFO)).toEqual({ root: '/docker/volumes/book-data/_data', fstype: 'btrfs', source: '/dev/vdb' });
    expect(parseMountInfo(BIND_MOUNTINFO)).toEqual({ root: '/Users/filipp/book-site-data', fstype: 'virtiofs', source: 'data' });
    expect(parseMountInfo('22 1 254:1 / / rw - overlay overlay rw')).toBeNull();
    expect(parseMountInfo('')).toBeNull();
  });

  it('accepts a volume and refuses every kind of host bind', () => {
    expect(judgeVolume({ root: '/docker/volumes/book-data/_data', fstype: 'btrfs' }).ok).toBe(true);
    // The Mac's disk through a FUSE filesystem: a bind whatever the path says.
    expect(judgeVolume({ root: '/docker/volumes/x/_data', fstype: 'virtiofs' }).ok).toBe(false);
    expect(judgeVolume({ root: '/Users/filipp/book-site-data', fstype: 'ext4' }).ok).toBe(false);
    expect(judgeVolume({ root: '/Volumes/Book/book-site-data', fstype: 'ext4' }).ok).toBe(false);
    expect(judgeVolume({ root: '/home/filipp/book-site-data', fstype: 'ext4' }).ok).toBe(false);
    expect(judgeVolume({ root: '/srv/book-site-data', fstype: 'ext4' }, { hostDataDir: '/srv/book-site-data' }).ok).toBe(false);
    expect(judgeVolume({ root: '/srv/book-site-data/live', fstype: 'ext4' }, { hostDataDir: '/srv/book-site-data' }).ok).toBe(false);
    expect(judgeVolume({ root: '/var/lib/docker/volumes/book-data/_data', fstype: 'ext4' }, { hostDataDir: '/srv/book-site-data' }).ok).toBe(true);
  });
});

/* -------------------------------------------------------------------------- the two machines -- */

describe('doctor — a deliberately broken machine', () => {
  it('exits 1 and names the bind, the writer’s state, the stray entry, the stale dump and the prose', async () => {
    const root = scratchRoot();
    const repo = makeRepo(root, { 'ch05.md': 'Пятая глава\n\nПроза, которой не должно быть в дереве.\n' });
    const backups = join(root, 'backups');
    const hostDump = makeHostBackup(backups, '20261026T044500', 30 * HOUR);
    const log = writeLog(join(root, 'book-backup.log'), [
      `${utcStamp(2 * HOUR)} level=error job=book-backup-drill status=fail backup=${hostDump} reason="counts drifted"`,
    ]);
    const body = doctorBody({
      dumps: {
        preMigration: {
          file: '/data/backups/pre-v22-20261026T044500Z.db',
          mtimeMs: Date.now() - 30 * HOUR,
          bytes: 100,
          integrity: 'ok',
          userVersion: 22,
        },
      },
      dataDir: {
        path: '/data',
        entries: ['admin.token', 'book.db', 'notes.txt'],
        denied: ['writer/state.json'],
        stray: ['notes.txt'],
        tokens: { admin: true, engine: true },
      },
    });
    const stack = await stubServer(readyRoutes(body));

    const report = await runDoctor({
      target: new URL(stack.base),
      token: TOKEN,
      repoRoot: repo,
      backupRoot: backups,
      drillLog: log,
      docker: dockerStub({ mountinfo: BIND_MOUNTINFO }),
      fetchImpl: fetchLike,
      gitLsFiles: async () => ['manuscript/ch05.md'],
    });

    expect(report.exitCode).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.checks.map((check) => check.id)).toEqual(IDS);
    expect(byId(report, 'runtime').verdict).toBe('fail');
    expect(byId(report, 'db_home').verdict).toBe('fail');
    expect(byId(report, 'backups').verdict).toBe('fail');
    expect(byId(report, 'git_prose').verdict).toBe('fail');
    // One failure the bind mount, one the writer, one the stray entry, one the prose in the tree.
    expect(byId(report, 'runtime').failures[0]).toContain('/Users/filipp/book-site-data');
    expect(byId(report, 'runtime').failures[0]).toContain('virtiofs');
    const dbHome = byId(report, 'db_home').failures.join(' ');
    expect(dbHome).toContain('writer/state.json');
    expect(dbHome).toContain('notes.txt');
    expect(dbHome).toContain('manuscript/ch05.md');
    expect(byId(report, 'backups').failures[0]).toMatch(/ is 30h old \(limit 24h\)/u);
    expect(byId(report, 'backups').failures.join(' ')).toContain('status=fail');
    expect(byId(report, 'git_prose').failures[0]).toContain('manuscript/ch05.md');
    expect(byId(report, 'git_prose').failures[0]).toContain('1 manuscript');
    // The counts and the frame are intact, so those rows pass — the table is a diagnosis.
    expect(byId(report, 'schema').verdict).toBe('pass');
    expect(byId(report, 'reset_dry_run').verdict).toBe('pass');
    expect(byId(report, 'frame').verdict).toBe('pass');
    expect(byId(report, 'graph').verdict).toBe('not_shipped');
    // Nothing that carries the token or a row ever reaches the report.
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });

  it('prints the table, the failures and «not ready», and --json prints the report alone', async () => {
    const root = scratchRoot();
    const repo = makeRepo(root, { 'ch05.md': 'Глава пятая\n\nПроза.\n' });
    const body = doctorBody({ dataDir: { path: '/data', denied: ['writer/pre'], stray: [], tokens: { admin: true, engine: true } } });
    const stack = await stubServer(readyRoutes(body));
    const report = await runDoctor({
      target: new URL(stack.base),
      token: TOKEN,
      repoRoot: repo,
      backupRoot: join(root, 'no-backups'),
      drillLog: join(root, 'no-such.log'),
      docker: dockerStub(),
      fetchImpl: fetchLike,
      gitLsFiles: async () => [],
    });

    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const asJson: string[] = [];
    try {
      printDoctorReport(report);
      const human = [...lines];
      lines.length = 0;
      printDoctorReport(report, { json: true });
      asJson.push(...lines);
      // The table: header, one row per check, then one line per failure, then the verdict.
      expect(human[0]?.replace(/\s+/gu, ' ').trim()).toBe('check | verdict | evidence');
      const rows = human.slice(1, 1 + IDS.length).map((line) => line.split('|').map((cell) => cell.trim()));
      expect(rows.map((row) => row[0])).toEqual(report.checks.map((check) => check.label));
      expect(rows.map((row) => row[1])).toEqual(report.checks.map((check) => (check.verdict === 'not_shipped' ? 'not shipped' : check.verdict)));
      expect(rows[0]?.[2]).toBe(report.checks[0]?.evidence);
      const failures = human.slice(1 + IDS.length, -1);
      expect(failures.length).toBeGreaterThan(0);
      expect(failures.every((line) => line.startsWith('  - '))).toBe(true);
      expect(failures.some((line) => line.startsWith('  - db_home: '))).toBe(true);
      const failed = report.checks.filter((check) => check.verdict === 'fail').length;
      expect(human.at(-1)).toBe(`not ready — ${String(failed)} check(s) failed`);
    } finally {
      spy.mockRestore();
    }
    // `--json` is one line, parses, keeps the order, and prints no table.
    expect(asJson).toHaveLength(1);
    const parsed = JSON.parse(asJson[0] ?? '') as DoctorReport;
    expect(parsed.checks.map((check) => check.id)).toEqual(IDS);
    expect(parsed.exitCode).toBe(1);
    expect(asJson[0]).not.toContain('check |');
    expect(asJson[0]).not.toContain('not ready');
  });
});

describe('doctor — a ready machine', () => {
  it('exits 0 with every row pass and the graph row a warning', async () => {
    const root = scratchRoot();
    const repo = makeRepo(root, { 'ch01.md': FRAME_FIRST_SENTENCE, 'ch42.md': FRAME_LAST_SENTENCE });
    const backups = join(root, 'backups');
    const hostDump = makeHostBackup(backups, '20261028T060000', HOUR);
    const drillAt = utcStamp(2 * HOUR);
    const log = writeLog(join(root, 'book-backup.log'), [
      `${utcStamp(9 * HOUR)} level=error job=book-backup-drill status=fail backup=/old reason="drill blew up"`,
      `${drillAt} level=info job=book-backup-drill status=ok backup=${hostDump} integrity=ok`,
    ]);
    const stack = await stubServer(readyRoutes());

    const report = await runDoctor({
      target: new URL(stack.base),
      token: TOKEN,
      repoRoot: repo,
      backupRoot: backups,
      drillLog: log,
      docker: dockerStub(),
      fetchImpl: fetchLike,
      gitLsFiles: async () => [],
    });

    expect(report.exitCode).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual(IDS);
    expect(report.checks.map((check) => check.verdict)).toEqual([
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
      'not_shipped',
      'pass',
      'pass',
    ]);
    expect(byId(report, 'runtime').evidence).toBe(`abc1234 · image ${IMAGE_SHORT} · volume /docker/volumes/book-data/_data (btrfs)`);
    expect(byId(report, 'schema').evidence).toBe('v23 = build v23 · dump pre-v22 2h ago integrity ok');
    expect(byId(report, 'db_home').evidence).toBe('data dir clean · manuscript/ no prose');
    expect(byId(report, 'frame').evidence).toBe(`ch01 ${sha(FRAME_FIRST_SENTENCE).slice(0, 8)} · ch42 ${sha(FRAME_LAST_SENTENCE).slice(0, 8)} · served ok`);
    expect(byId(report, 'reset_dry_run').evidence).toBe('2 counters · 412 rows · kept identities 3 · front_matter 1 · tokens admin+engine');
    expect(byId(report, 'graph').evidence).toBe('fact_dependency absent — stage 3 not in this image (warning)');
    expect(byId(report, 'graph').failures).toEqual([]);
    // The host dump is the newest, so it is the file that was actually opened read-only.
    expect(byId(report, 'backups').evidence).toBe(`${hostDump} 1h integrity ok · drill last run ${drillAt} (2h ago) status=ok`);
    expect(byId(report, 'git_prose').evidence).toBe('no manuscript files tracked');
    for (const check of report.checks) expect(check.failures, check.id).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ focused failures -- */

/** What one focused case may override: the stack's answers, the host's seams, the tree. */
type ReportOptions = { body?: Record<string, unknown>; reset?: Record<string, unknown>; routes?: Record<string, Route>; docker?: DockerCall; gitLsFiles?: (repoRoot: string) => Promise<string[] | null>; manuscript?: Record<string, string>; drill?: 'site' | 'root' | 'none'; openReadonly?: (file: string) => never };

describe('doctor — the rows that can go red on their own', () => {
  async function reportWith(options: ReportOptions = {}): Promise<DoctorReport> {
    const root = scratchRoot();
    const repo = makeRepo(root, options.manuscript ?? {}, options.drill ?? 'site');
    const backups = join(root, 'backups');
    makeHostBackup(backups, '20261028T060000', HOUR);
    const log = writeLog(join(root, 'book-backup.log'), [`${utcStamp(HOUR)} level=info job=book-backup-drill status=ok`]);
    const stack = await stubServer(options.routes ?? readyRoutes(options.body ?? doctorBody(), options.reset ?? resetBody()));
    return runDoctor({
      target: new URL(stack.base),
      token: TOKEN,
      repoRoot: repo,
      backupRoot: backups,
      drillLog: log,
      docker: options.docker ?? dockerStub(),
      fetchImpl: fetchLike,
      gitLsFiles: options.gitLsFiles ?? (async () => []),
      ...(options.openReadonly === undefined ? {} : { openReadonly: options.openReadonly }),
    });
  }

  it('a missing pre-migration dump fails schema, and a dump that does not open fails it too', async () => {
    const gone = await reportWith({ body: doctorBody({ dumps: { preMigration: null } }) });
    expect(byId(gone, 'schema').verdict).toBe('fail');
    expect(byId(gone, 'schema').failures[0]).toContain('no pre-migration dump');

    const dump = { file: '/data/backups/pre-v22.db', mtimeMs: Date.now() - 2 * HOUR, bytes: 1, integrity: 'malformed', userVersion: 22 };
    const corrupt = await reportWith({ body: doctorBody({ dumps: { preMigration: dump } }) });
    expect(byId(corrupt, 'schema').failures[0]).toContain('integrity malformed');
  });

  it('says SCHEMA_FUTURE for a DB ahead of the image, and names the pending migration behind it', async () => {
    const ahead = await reportWith({ body: doctorBody({ schema: { userVersion: 24, expected: 23 } }) });
    expect(byId(ahead, 'schema').failures[0]).toContain('SCHEMA_FUTURE');
    expect(byId(ahead, 'schema').failures[0]).toContain('v24');

    const behind = await reportWith({ body: doctorBody({ schema: { userVersion: 22, expected: 23 } }) });
    expect(byId(behind, 'schema').failures[0]).toBe('migration pending v22 → v23');
  });

  it('names a stopped container and an unhealthy one', async () => {
    const report = await reportWith({
      docker: dockerStub({
        states: {
          'book-engine-1': { Running: true, Status: 'running', health: 'starting' },
          'book-writer-1': { Running: false, Status: 'exited' },
        },
      }),
    });
    expect(byId(report, 'runtime').verdict).toBe('fail');
    const named = byId(report, 'runtime').failures.join(' ');
    expect(named).toContain('book-engine-1: health starting');
    expect(named).toContain('book-writer-1: not running (exited)');
  });

  it('fails the runtime row when the containers disagree about the image or the commit', async () => {
    const images = await reportWith({
      docker: dockerStub({
        images: { 'book-engine-1': `sha256:${'f'.repeat(64)}` },
      }),
    });
    expect(byId(images, 'runtime').failures.join(' ')).toContain('different images');

    const labelled = await reportWith({ docker: dockerStub({ label: 'deadbee' }) });
    expect(byId(labelled, 'runtime').failures.join(' ')).toContain('label book.commit deadbee');

    const unlabelled = await reportWith({ docker: dockerStub({ label: '<no value>' }) });
    expect(byId(unlabelled, 'runtime').failures.join(' ')).toContain('no book.commit label');
  });

  it('fails the runtime row when /healthz does not answer with a commit', async () => {
    const report = await reportWith({
      routes: { ...readyRoutes(), '/healthz': () => ({ status: 500, body: { code: 'BOOM' } }) },
    });
    expect(byId(report, 'runtime').verdict).toBe('fail');
    expect(byId(report, 'runtime').failures.join(' ')).toContain('/healthz answered 500');
  });

  it('fails the frame row when a DB row is missing or the served text drifted', async () => {
    const body = doctorBody({
      frame: { source: 'basis', rows: [{ chapter: 1, position: 'first', sha256: sha(FRAME_FIRST_SENTENCE) }] },
    });
    const report = await reportWith({
      body,
      routes: { ...readyRoutes(body), '/api/chapters/42': () => ({ body: { chapter: 42, blocks: [{ text: 'Свет погас.' }] } }) },
    });
    expect(byId(report, 'frame').verdict).toBe('fail');
    const named = byId(report, 'frame').failures.join(' ');
    expect(named).toContain('frame ch42/last: no row in the DB');
    expect(named).toContain('site /api/chapters/42');
  });

  it('fails the dry run when its total, its keep-list or a token is not right', async () => {
    const report = await reportWith({
      reset: resetBody({ total: 999, kept: [{ key: 'identities', rows: 3 }] }),
      body: doctorBody({ dataDir: { path: '/data', denied: [], stray: [], tokens: { admin: true, engine: false } } }),
    });
    expect(byId(report, 'reset_dry_run').verdict).toBe('fail');
    const named = byId(report, 'reset_dry_run').failures.join(' ');
    expect(named).toContain('total 999');
    expect(named).toContain('no front_matter');
    expect(named).toContain('no engine token');
  });

  it('fails the dry run when the route refuses the token', async () => {
    const routes = { ...readyRoutes(), '/api/admin/reset/book': () => ({ status: 401, body: { code: 'UNAUTHORIZED' } }) };
    const report = await reportWith({ routes });
    expect(byId(report, 'reset_dry_run').failures[0]).toBe('POST /api/admin/reset/book answered 401 UNAUTHORIZED');
  });

  it('fails a shipped graph that is empty or slow, and passes a populated one', async () => {
    const empty = await reportWith({ body: doctorBody({ graph: { shipped: true, facts: 0, threads: 5, edges: 9, closureMs: 120 } }) });
    expect(byId(empty, 'graph').verdict).toBe('fail');
    const named = byId(empty, 'graph').failures.join(' ');
    expect(named).toContain('no facts (0)');
    expect(named).toContain('120 ms');

    const fine = await reportWith({ body: doctorBody({ graph: { shipped: true, facts: 4, threads: 2, edges: 9, closureMs: 7 } }) });
    expect(byId(fine, 'graph').verdict).toBe('pass');
    expect(byId(fine, 'graph').evidence).toBe('facts 4 · threads 2 · edges 9 · closure 7 ms');
  });

  it('passes git_prose on a tree that is not a checkout, and keeps backups fresh from the host dump', async () => {
    const noGit = await reportWith({ gitLsFiles: async () => null });
    expect(byId(noGit, 'git_prose').verdict).toBe('pass');
    expect(byId(noGit, 'git_prose').evidence).toBe('no git checkout — nothing tracked');

    // With no in-volume dump the newest backup is the host copy, so the row still passes.
    const report = await reportWith({ body: doctorBody({ dumps: { preMigration: null } }) });
    expect(byId(report, 'backups').verdict).toBe('pass');
    expect(byId(report, 'backups').evidence).toContain('integrity ok');
  });

  it('names what is missing when there is no backup and no drill at all', async () => {
    const root = scratchRoot();
    const repo = makeRepo(root);
    const stack = await stubServer(readyRoutes(doctorBody({ dumps: { preMigration: null } })));
    const run = (backupRoot: string) =>
      runDoctor({ target: new URL(stack.base), token: TOKEN, repoRoot: repo, backupRoot, drillLog: join(root, 'absent.log'), docker: dockerStub(), fetchImpl: fetchLike, gitLsFiles: async () => [] });

    const named = byId(await run(join(root, 'empty-backups')), 'backups').failures.join(' ');
    expect(named).toContain('no backup found');
    expect(named).toContain('empty-backups');
    expect(named).toContain('absent.log');

    // A stale host copy is the newest candidate, so it is the file the row names.
    const stale = makeHostBackup(join(root, 'stale-backups'), '20261026T044500', 30 * HOUR);
    expect(byId(await run(join(root, 'stale-backups')), 'backups').failures[0]).toBe(`${stale} is 30h old (limit 24h)`);
  });

  it('fails the dry run when the doctor answer omits its data dir, and the dry run its total', async () => {
    const bare = await reportWith({ body: doctorBody({ dataDir: {} }), reset: resetBody({ total: undefined }) });
    expect(byId(bare, 'db_home').failures[0]).toContain('no denied/stray lists');
    expect(byId(bare, 'reset_dry_run').failures.join(' ')).toContain('no total');
  });

  it('finds the restore drill at site/deploy and at deploy, and names both when it is absent', async () => {
    expect(byId(await reportWith(), 'backups').failures.join(' ')).not.toContain('restore drill');
    expect(byId(await reportWith({ drill: 'root' }), 'backups').failures.join(' ')).not.toContain('restore drill');
    expect(byId(await reportWith({ drill: 'none' }), 'backups').failures.join(' ')).toContain('site/deploy/restore-drill.sh');
  });

  it('fails the backups row when the newest host copy does not open', async () => {
    const report = await reportWith({
      openReadonly: () => {
        throw new Error('file is not a database');
      },
    });
    expect(byId(report, 'backups').verdict).toBe('fail');
    expect(byId(report, 'backups').failures.join(' ')).toContain('integrity unreadable: file is not a database');
  });

  it('says the doctor route refused the token, and still answers with all eight rows', async () => {
    const routes: Record<string, Route> = {
      '/healthz': () => ({ body: { ok: true, commit: COMMIT } }),
      '/api/admin/doctor': () => ({ status: 401, body: { code: 'UNAUTHORIZED' } }),
    };
    const report = await reportWith({ routes });
    expect(report.exitCode).toBe(1);
    expect(report.checks).toHaveLength(IDS.length);
    expect(byId(report, 'schema').failures[0]).toContain('refused (401)');
    // The host's own rows still run: a refused token is one fact, not a reason to stop.
    expect(byId(report, 'git_prose').verdict).toBe('pass');
  });
});

/* ------------------------------------------------------------------------- the process itself -- */

describe('doctor — the process an operator runs', () => {
  it('exits 3 with no admin token, and prints no value', async () => {
    scratchRoot();
    const result = await runCli(['doctor'], { PATH: process.env.PATH ?? '/usr/bin:/bin' });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('no admin token');
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(TOKEN);
  });

  it('exits 0 on --help and names the command', async () => {
    scratchRoot();
    const result = await runCli(['--help'], { PATH: process.env.PATH ?? '/usr/bin:/bin' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('node bin/admin.mjs doctor [--json] [--url <url>]');
    expect(result.stdout).toContain('--json');
    expect(result.stdout).toContain('exit 0 ready · 1 not ready');
  });

  it('prints a JSON report and exits 1 when the stack is not there', { timeout: 30_000 }, async () => {
    const root = scratchRoot();
    const repo = makeRepo(root);
    const stack = await stubServer(readyRoutes());
    const result = await runCli(['doctor', '--json', '--url', stack.base], {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: root,
      ADMIN_TOKEN: TOKEN,
      ADMIN_TOKEN_FILE: '',
      DATA_DIR: join(root, 'data'),
      // A project name no machine has: docker is either absent or finds nothing, and no real
      // container is ever inspected by a test.
      BOOK_PROJECT: 'book-doctor-no-such-project',
      BOOK_REPO_ROOT: repo,
      BACKUP_ROOT: join(root, 'backups'),
      LOG_FILE: join(root, 'no-such.log'),
    });
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(report.checks.map((check) => check.id)).toEqual(IDS);
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    // The JSON is the whole of stdout — a driver parses it, so no table may creep in.
    expect(result.stdout).not.toContain('check |');
    expect(result.stdout).not.toContain('not ready —');
    expect(result.stdout).not.toContain(TOKEN);
  });
});
