/**
 * Mounted secrets (ARCHITECTURE.md §21.2, invariant 30). A secret comes from a file named by
 * `${NAME}_FILE`; in production a plain value is refused, because `--env-file` and
 * `docker inspect` both expose the environment.
 *
 * `YANDEX_CLIENT_ID`/`YANDEX_CLIENT_SECRET` are OPTIONAL mounts: compose cannot make a mount
 * conditional, so the site service always declares both, and a host without them mounts an empty
 * directory. For these two a declared file that is missing, unreadable, empty or a directory is
 * "no credential" — one warning per missing file and sign-in off — never a boot failure, because
 * ADR-021 makes sign-in optional and a deployment without OAuth is a legitimate shape (BOOK-205).
 * Every other name keeps the fatal rule below.
 *
 * `ADMIN_TOKEN`/`ENGINE_TOKEN` are absent on purpose: their contract is implemented next to
 * them (`readAdminToken`, and the engine mints its token on a local first boot), and a missing
 * optional panel token must keep disabling the panel instead of failing the whole boot.
 */

import { readFileSync, statSync } from 'node:fs';

export type MountedSecret =
  | 'SESSION_SECRET'
  | 'IP_SALT'
  | 'YANDEX_CLIENT_ID'
  | 'YANDEX_CLIENT_SECRET'
  | 'CAPTCHA_SECRET';

/** The names whose absence is a deployment shape, not a defect (ADR-021, BOOK-205). */
const OPTIONAL: ReadonlySet<MountedSecret> = new Set<MountedSecret>(['YANDEX_CLIENT_ID', 'YANDEX_CLIENT_SECRET']);

/**
 * The trimmed text of a mounted file, or `undefined` when there is nothing to read. A directory is
 * what Docker mounts when the host bind source is absent, so it is checked explicitly; the catch
 * stays about permissions and a missing path.
 */
function readMountedFile(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
}

/**
 * Resolves a mounted secret. The file wins over the plain variable in every environment.
 * In production the file is the only accepted source: a plain value is refused (invariant 30
 * — `--env-file` and `docker inspect` both expose it), and there is no opt-out. A blank value
 * is no secret at all, so the required checks below report it with their own message.
 * Outside production the plain variable is accepted, so tests and local development need no
 * files. For a REQUIRED name a declared file that is missing, unreadable or empty is a boot
 * failure everywhere — never a silent "no session secret, no CAPTCHA secret". For an OPTIONAL
 * name the same condition is one warning and `undefined`: the boot continues with sign-in off.
 * The messages carry the variable name only, never a value or a path.
 */
export function readMountedSecret(
  env: NodeJS.ProcessEnv,
  name: MountedSecret,
  production: boolean,
): string | undefined {
  const file = env[`${name}_FILE`];
  if (file === undefined || file.trim().length === 0) {
    const plain = env[name];
    if (!production) return plain;
    // A blank value is no secret at all: the required checks below report it more plainly.
    if ((plain ?? '').trim().length === 0) return undefined;
    throw new Error(
      `invalid configuration: ${name} must come from ${name}_FILE in production, ` +
        'never from a plain value (invariant 30)',
    );
  }
  const value = readMountedFile(file.trim());
  if (value !== undefined && value.length > 0) return value;
  if (OPTIONAL.has(name)) {
    // The operator declared the mount and the mount has nothing usable in it: sign-in cannot work,
    // so say so once and keep the book serving (ADR-021). A half pair lands here too — either half
    // unusable means `yandexConfigured` is false and `/auth/yandex/start` answers 503.
    console.warn(
      `${name}_FILE is missing, unreadable or empty — sign-in is off (503 OAUTH_UNCONFIGURED); ` +
        'the book keeps serving',
    );
    return undefined;
  }
  if (value === undefined) throw new Error(`invalid configuration: cannot read ${name}_FILE`);
  throw new Error(`invalid configuration: ${name}_FILE is empty`);
}
