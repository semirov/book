/**
 * Mounted secrets (ARCHITECTURE.md §21.2, invariant 30). A secret comes from a file named by
 * `${NAME}_FILE`; in production a plain value is refused, because `--env-file` and
 * `docker inspect` both expose the environment.
 *
 * `ADMIN_TOKEN`/`ENGINE_TOKEN` are absent on purpose: their contract is implemented next to
 * them (`readAdminToken`, and the engine mints its token on a local first boot), and a missing
 * optional panel token must keep disabling the panel instead of failing the whole boot.
 */

import { readFileSync } from 'node:fs';

export type MountedSecret =
  | 'SESSION_SECRET'
  | 'IP_SALT'
  | 'YANDEX_CLIENT_ID'
  | 'YANDEX_CLIENT_SECRET'
  | 'CAPTCHA_SECRET';

/**
 * Resolves a mounted secret. The file wins over the plain variable in every environment.
 * In production the file is the only accepted source: a plain value is refused (invariant 30
 * — `--env-file` and `docker inspect` both expose it), and there is no opt-out. A blank value
 * is no secret at all, so the required checks below report it with their own message.
 * Outside production the plain variable is accepted, so tests and local development need no
 * files. A declared file that is missing, unreadable or empty is a boot failure everywhere —
 * never a silent "no session secret, no CAPTCHA secret". The messages carry the variable name
 * only, never a value or a path.
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
  let value: string;
  try {
    value = readFileSync(file.trim(), 'utf8').trim();
  } catch {
    throw new Error(`invalid configuration: cannot read ${name}_FILE`);
  }
  if (value.length === 0) throw new Error(`invalid configuration: ${name}_FILE is empty`);
  return value;
}
