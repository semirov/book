/**
 * BOOK-217 — the driven launchd runs these tests share: a real clone, a real state dir, a real
 * volume, a real HTTP site and fake `launchctl`/`npm` on `PATH`. Not a test file (vitest collects
 * `*.test.ts`): the primitives live here so `deployRecovery.test.ts` stays under the 500-line arch
 * limit while every driven case runs the script the workflow runs.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BASH, DEPLOY, OK, fakes, gitRoot, serve, temp } from './deployHarness.ts';

export const LABEL = 'dev.book-site.test';
export const BUILT = 'abc1234';
export const DUMP = 'pre-v29-20261029T085300Z.db';
export const MOVED = `the boot dumped v29 before migrating (backups/${DUMP})`;
export const SCHEMA_TS = 'site/server/src/db/schema.ts';

/** The service's own plist, as `plutil -extract EnvironmentVariables.DATA_DIR raw` reads it. */
export function plist(root: string, dataDir: string, port: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>WorkingDirectory</key><string>${root}/site</string>
<key>EnvironmentVariables</key><dict>
<key>DATA_DIR</key><string>${dataDir}</string>
<key>HOST</key><string>127.0.0.1</string>
<key>PORT</key><string>${port}</string>
</dict>
</dict></plist>
`;
}

/**
 * `plutil -extract <key> raw <plist>` as `deploy.sh:plist_field` drives it: the string value of the
 * **last path component** of `<key>` (`EnvironmentVariables.DATA_DIR` → `DATA_DIR`), read out of the
 * staged plist, so `site_url`/`service_root_guard`/`data_dir_of_service` see what the fixture wrote.
 * A key that is absent, a value that is not a string and a file that is missing all exit 1 — the
 * contract `plist_field` relies on (`|| return 1`, `2>/dev/null`). An empty value also exits 1 (the
 * real tool prints an empty line): no fixture writes one, and a deploy treats both the same way.
 *
 * The real `plutil` is macOS-only: without this fake the driven cases pass on macOS and die on the
 * ubuntu-latest gate job with "the service names no DATA_DIR".
 */
function fakePlutil(): string {
  return `[ "$1" = "-extract" ] && [ "$3" = "raw" ] && [ -n "$2" ] || exit 1
plist="$4"
[ -f "$plist" ] || exit 1
key="\${2##*.}"
# One <key>K</key><string>V</string> pair per line is how the fixture writes it; the first match is
# the value, and a key whose neighbour is a <dict> is not a string and finds none.
value="$(sed -n "s|.*<key>\${key}</key><string>\\(.*\\)</string>.*|\\1|p" "$plist" | head -n 1)"
[ -n "$value" ] || exit 1
printf '%s\\n' "$value"`;
}

/**
 * The box's tools, faked the way `deployHarness` fakes `sysctl`: `npm` succeeds and records its argv
 * (creating the `current` symlink a publish leaves, which the driver reads back), `launchctl print`
 * is a healthy job, `plutil` reads the staged plist (see `fakePlutil`), and `kickstart` does what the
 * boot of a new build does to the volume — the pre-migration dump, once. The volume marker is NOT
 * written: `boot.ts` never refreshes `schema=`, so a driver that read it would compare one number
 * with itself.
 *
 * BOOK-232: `sqlite3 -readonly <db> 'PRAGMA user_version;'` answers `FAKE_SQLITE_SCHEMA` — the number
 * the guard must decide on, in the shape the real tool prints. Unset means "the file cannot be read"
 * (the real tool's exit 1 with its message), which is the `unknown` the guard must refuse rather than
 * round to "not migrated".
 */
export function fakeTools(
  stateDir: string,
  dataDir: string,
  boot = `mkdir -p "${dataDir}/backups"\nprintf 'DUMP v29\\n' > "${dataDir}/backups/${DUMP}"`,
): string {
  return fakes({
    npm: `printf '%s\\n' "$*" >> "${stateDir}/npm.log"
if [ "$1" = "run" ] && [ "$2" = "release:publish" ]; then
  mkdir -p web/dist
  ln -sfn book-test-release web/dist/current
fi
exit 0`,
    launchctl: `printf '%s\\n' "$*" >> "${stateDir}/launchctl.log"
case "$1" in
  print)
    printf '\\tstate = running\\n\\truns = 3\\n\\tlast exit code = 0\\n'
    exit 0 ;;
  kickstart)
    if [ ! -e "${stateDir}/booted" ]; then
      : > "${stateDir}/booted"
      ${boot}
    fi
    exit 0 ;;
esac
exit 0`,
    plutil: fakePlutil(),
    sqlite3: `[ "$1" = "-readonly" ] || { echo "Usage: sqlite3 [-readonly] FILE" >&2; exit 1; }
[ -n "\${FAKE_SQLITE_SCHEMA:-}" ] || { echo "Error: unable to open database file" >&2; exit 1; }
printf '%s\\n' "\${FAKE_SQLITE_SCHEMA}"`,
  });
}

/** The script as the workflow runs it, asynchronously: the site under test is this process's own. */
export function runDeploy(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(BASH, [DEPLOY, ...args], { env });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      out += String(chunk);
    });
    child.on('close', (code: number | null) => {
      done({ code, out });
    });
  });
}

/** Every tool the driven path has to see from the fake bin dir; a macOS-only tool resolved from
 * `/usr/bin` instead would pass here and die on the ubuntu-latest gate job. */
const ON_PATH = ['plutil', 'launchctl', 'sqlite3'];

/** The fakes must shadow the box's own tools: `command -v`, as a shell would resolve them. */
function assertFaked(env: Record<string, string>, bin: string): void {
  for (const name of ON_PATH) {
    const resolved = execFileSync(BASH, ['-c', `command -v ${name}`], { encoding: 'utf8', env }).trim();
    if (!resolved.startsWith(bin)) {
      throw new Error(`${name} resolves to '${resolved}', not the fake in ${bin}: the driven cases would pass on macOS and fail elsewhere`);
    }
  }
}

export type Staged = { root: string; stateDir: string; dataDir: string; home: string; url: string; head: string; env: Record<string, string> };

/**
 * A clone, a state dir, a volume and a home as the workflow builds them: `--phase run` gets past the
 * gate on fakes, the site under test is this process's own server (`answer` is the commit it
 * reports, `BUILT` by default), and the only volume change the boot makes is the one the caller
 * names (`boot: ''` dumps nothing; `backups: 'absent'` is a volume no dump has ever written to).
 */
export async function stage(options: { frame?: number; boot?: string; backups?: 'absent'; answer?: string } = {}): Promise<Staged> {
  const root = gitRoot();
  const stateDir = temp('book-217-launchd-state-');
  const dataDir = temp('book-217-launchd-volume-');
  const home = temp('book-217-launchd-home-');
  // The volume as the previous build left it: a v29 database, no dump.
  writeFileSync(join(dataDir, 'book.db'), 'BOOK-DB-v29\n', 'utf8');
  // `backups: 'absent'` is a volume that never took a dump (the boot creates the directory when it
  // dumps), so its listing is empty — a fact. A directory that EXISTS and cannot be read is a failed
  // read, and a test stages that one with `chmod` on the volume it was given.
  if (options.backups !== 'absent') mkdirSync(join(dataDir, 'backups'), { recursive: true });

  // A clone whose build names its commit and whose CLIs are silent successes; the frame check is the
  // caller's verdict (1 = the canon does not answer, 0 = the run is green).
  writeFileSync(join(root, 'site', 'build-info.json'), `${JSON.stringify({ commit: BUILT })}\n`, 'utf8');
  mkdirSync(join(root, 'site', 'bin'), { recursive: true });
  for (const name of ['home-migrate.mjs', 'home-check.mjs', 'validate.mjs']) {
    writeFileSync(join(root, 'site', 'bin', name), 'process.exit(0);\n', 'utf8');
  }
  mkdirSync(join(root, 'site', 'scripts'), { recursive: true });
  writeFileSync(join(root, 'site', 'scripts', 'frame-check.mjs'), `process.exit(${options.frame ?? 1});\n`, 'utf8');

  const url = await serve(() => OK(options.answer ?? BUILT));
  const port = new URL(url).port;
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`), plist(root, dataDir, port), 'utf8');
  writeFileSync(join(stateDir, 'previous'), `${'a'.repeat(40)}\n`, 'utf8');
  writeFileSync(join(stateDir, 'last-good'), 'knowngood\n', 'utf8');
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const bin = fakeTools(stateDir, dataDir, options.boot);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('BOOK_') || key === 'GITHUB_ACTIONS') continue;
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HOME: home,
    BOOK_STATE_DIR: stateDir,
    BOOK_DEPLOY_ROOT: root,
    BOOK_SERVICE_LABEL: LABEL,
    BOOK_LOAD_PER_CORE_MAX: '1000', // never pause on this box's load; the test is not about it
    BOOK_HEALTH_TIMEOUT: '5',
    BOOK_HEALTH_GRACE: '1',
  });
  assertFaked(env, bin);
  return { root, stateDir, dataDir, home, url, head, env };
}

/** One commit that carries a schema constant: what `git show <sha>:…/schema.ts` reads. */
export function commitSchema(root: string, version: number): string {
  const file = join(root, SCHEMA_TS);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `export const SCHEMA_VERSION = ${version};\n`, 'utf8');
  execFileSync('git', ['-C', root, 'add', SCHEMA_TS]);
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', `schema ${version}`]);
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

/** One log file, as lines; a file that was never written is no lines. */
export const logLines = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []);
