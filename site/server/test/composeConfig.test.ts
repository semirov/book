/**
 * BOOK-172 — the compose file IS the production topology, so its numbers and its mount shapes are
 * contracts, not preferences. This file reads them the way the release script does (`docker compose
 * config`, always with `--env-file /dev/null`, so no host `.env` can answer for a test) and asserts
 * the decisions the runbook states:
 *
 *   · one image, three services, one published port (site on the Mac's LAN address);
 *   · every service non-root, read-only rootfs, `cap_drop: ALL`, no privilege gain, tmpfs /tmp,
 *     and a stated CPU/memory/pids ceiling;
 *   · the data dir is a host bind mount, the manuscript is read-only into site and engine and only
 *     `manuscript/` is writable into the writer;
 *   · secrets are PATHS (`*_FILE`), never values, and the site and engine both get the session
 *     secret and IP salt the engine's boot refuses to start without;
 *   · healthchecks mean something: `/healthz` AND the image's own commit (site), the token-guarded
 *     `/internal/health` (engine), and none for the portless writer.
 *
 * Docker is optional here on purpose: the gate job may not ship the compose plugin. When
 * `docker compose version` fails, every case in this file is skipped with a reason, never faked.
 */

import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SITE = resolve(import.meta.dirname, '..', '..');
const FILE = join(SITE, 'docker-compose.yml');

/** Nothing ambient may decide a topology assertion. */
function cleanEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('BOOK_')) continue;
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
}

function compose(args: string[], env: Record<string, string>) {
  return spawnSync('docker', args, { cwd: SITE, encoding: 'utf8', env: cleanEnv(env), timeout: 60_000 });
}

const plugin = compose(['compose', 'version'], {}).status === 0;
const skip = plugin ? false : 'docker compose is not available on this box';

type Service = {
  image?: string;
  user?: string;
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  tmpfs?: string[];
  cpus?: number | string;
  mem_limit?: string | number;
  pids_limit?: number;
  stop_grace_period?: string;
  ports?: { host_ip?: string; published?: string; target?: number }[];
  volumes?: { type: string; source?: string; target: string; read_only?: boolean }[];
  environment?: Record<string, string>;
  healthcheck?: { test: string[] };
  logging?: { driver: string; options?: Record<string, string> };
  depends_on?: Record<string, { condition?: string; required?: boolean }>;
  env_file?: unknown;
};

type Config = { name?: string; services: Record<string, Service> };

/** The rehearsal overrides: the same file, no prod path anywhere. */
const REHEARSAL: Record<string, string> = {
  BOOK_SITE_PUBLISH: '192.168.1.76:8092',
  BOOK_DATA_DIR: '/tmp/book-172/data',
  BOOK_MANUSCRIPT: '/tmp/book-172/book',
  BOOK_SECRETS_DIR: '/tmp/book-172/secrets',
  BOOK_LOCKS_DIR: '/tmp/book-172/locks',
  BOOK_IMAGE_TAG: 'book:test',
};

/**
 * The production bind source, assembled from parts for the same reason `dataIsolation.test.ts`
 * assembles its needles: no test file may contain that literal, even to assert on it.
 */
const PROD_DATA_DIR = ['/Users/filipp/book', 'site', 'data'].join('-');

function loaded(overrides: Record<string, string> = {}): Config {
  const result = compose(['compose', '--env-file', '/dev/null', '-f', FILE, 'config', '--format', 'json'], overrides);
  if (result.status !== 0) throw new Error(`docker compose config failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as Config;
}

const mount = (service: Service, target: string) => (service.volumes ?? []).find((volume) => volume.target === target);

describe.skipIf(skip)('the compose topology', () => {
  it('names one project and exactly three services', () => {
    const config = loaded(REHEARSAL);
    expect(config.name).toBe('book');
    expect(Object.keys(config.services).sort()).toEqual(['engine', 'site', 'writer']);
  });

  it('publishes the site on the Mac LAN address and nothing else anywhere', () => {
    const config = loaded(REHEARSAL);
    const ports = config.services.site?.ports ?? [];
    expect(ports).toHaveLength(1);
    expect(ports[0]?.host_ip).toBe('192.168.1.76');
    expect(ports[0]?.published).toBe('8092');
    expect(ports[0]?.target).toBe(8080);
    expect(config.services.engine?.ports ?? []).toHaveLength(0);
    expect(config.services.writer?.ports ?? []).toHaveLength(0);
    // The production default, unchanged: the flip needs no edit to publish on 8091.
    expect(loaded().services.site?.ports?.[0]?.published).toBe('8091');
  });

  it('hardens every service and states its ceiling', () => {
    const config = loaded(REHEARSAL);
    for (const name of ['site', 'engine', 'writer']) {
      const service = config.services[name] as Service;
      expect(service.user, name).toBe('501:20');
      expect(service.read_only, name).toBe(true);
      expect(service.cap_drop, name).toEqual(['ALL']);
      expect(service.security_opt, name).toContain('no-new-privileges:true');
      expect(service.tmpfs?.join(' '), name).toContain('/tmp:rw,noexec,nosuid,nodev');
      expect(Number(service.cpus), name).toBeGreaterThan(0);
      expect(Number(service.mem_limit), name).toBeGreaterThan(0);
      expect(Number(service.pids_limit), name).toBeGreaterThan(0);
      // `compose config` normalises the duration (`30s`, and `1m0s` for the engine's 60s): what the
      // ceiling must be is a real duration, not one particular spelling of it.
      expect(service.stop_grace_period, name).toMatch(/^(\d+h)?(\d+m)?\d+s$/u);
    }
    // The caps fit the box: 4 of the VM's 10 CPUs and 2.5 of its 12 GiB, ceilings not reservations.
    const cpus = ['site', 'engine', 'writer'].reduce((sum, name) => sum + Number(config.services[name]?.cpus), 0);
    const mem = ['site', 'engine', 'writer'].reduce((sum, name) => sum + Number(config.services[name]?.mem_limit), 0);
    expect(cpus).toBe(4);
    expect(mem).toBe(2560 * 1024 * 1024);
  });

  it('mounts the host data dir and keeps the manuscript read-only where prose is not written', () => {
    const config = loaded(REHEARSAL);
    for (const name of ['site', 'engine', 'writer']) {
      const data = mount(config.services[name] as Service, '/data');
      expect(data?.source, name).toBe('/tmp/book-172/data');
      expect(data?.read_only, name).toBeFalsy();
      expect(mount(config.services[name] as Service, '/locks')?.source, name).toBe('/tmp/book-172/locks');
    }
    for (const name of ['site', 'engine']) {
      expect(mount(config.services[name] as Service, '/book')?.read_only, name).toBe(true);
    }
    const writer = config.services.writer as Service;
    expect(mount(writer, '/book')?.read_only).toBe(true);
    expect(mount(writer, '/book/manuscript')?.read_only).toBeFalsy();
    // The production default is the host path the launchd jobs and backup.sh already use.
    expect(mount(loaded().services.site as Service, '/data')?.source).toBe(PROD_DATA_DIR);
  });

  it('carries secret PATHS only, and gives site and engine the two the boot requires', () => {
    const config = loaded(REHEARSAL);
    const site = config.services.site?.environment ?? {};
    const engine = config.services.engine?.environment ?? {};
    const writer = config.services.writer?.environment ?? {};
    for (const env of [site, engine]) {
      expect(env.SESSION_SECRET_FILE).toBe('/run/secrets/session_secret');
      expect(env.IP_SALT_FILE).toBe('/run/secrets/ip_salt');
    }
    expect(writer.SESSION_SECRET_FILE).toBeUndefined();
    expect(writer.IP_SALT_FILE).toBeUndefined();
    expect(writer.DEEPSEEK_API_KEY_FILE).toBe('/run/secrets/deepseek_key');
    expect(writer.ENGINE_TOKEN_FILE).toBe('/data/engine.token');
    // No plain secret value may exist under any name (invariant 30): every match is a `*_FILE` path.
    for (const name of ['site', 'engine', 'writer']) {
      for (const key of Object.keys(config.services[name]?.environment ?? {})) {
        if (/SECRET|SALT|API_KEY/u.test(key)) expect(key, `${name}:${key}`).toMatch(/_FILE$/u);
      }
    }
    // No host `.env` reaches a service: the topology is this file, not the launchd env.
    for (const name of ['site', 'engine', 'writer']) {
      expect(config.services[name]?.env_file, name).toBeUndefined();
    }
    const secrets = (config.services.site?.volumes ?? []).filter((volume) => volume.target.startsWith('/run/secrets'));
    expect(secrets.map((volume) => volume.target).sort()).toEqual(['/run/secrets/ip_salt', '/run/secrets/session_secret']);
    expect(secrets.every((volume) => volume.read_only)).toBe(true);
  });

  it('gives the site and engine a healthcheck that means something, and the writer none', () => {
    const config = loaded(REHEARSAL);
    for (const name of ['site', 'engine']) {
      const test = config.services[name]?.healthcheck?.test ?? [];
      expect(test.join(' '), name).toContain('/app/deploy/healthcheck.mjs');
      expect(test.join(' '), name).toContain(name);
    }
    expect(config.services.writer?.healthcheck).toBeUndefined();
  });

  it('bounds the logs with json-file rotation on every service', () => {
    const config = loaded(REHEARSAL);
    // The two request-serving services keep the short rotation; the writer lane logs every stage of a
    // pass (up to 45 minutes), so it is the one with the longer history.
    const wanted: Record<string, [string, string]> = {
      site: ['10m', '3'],
      engine: ['10m', '3'],
      writer: ['20m', '5'],
    };
    for (const name of ['site', 'engine', 'writer']) {
      const logging = config.services[name]?.logging;
      expect(logging?.driver, name).toBe('json-file');
      expect(logging?.options?.['max-size'], name).toBe(wanted[name]?.[0]);
      expect(logging?.options?.['max-file'], name).toBe(wanted[name]?.[1]);
    }
    const [siteSize, siteFiles] = wanted.site ?? ['0m', '0'];
    const writerSize = config.services.writer?.logging?.options?.['max-size'] ?? '0m';
    const writerFiles = Number(config.services.writer?.logging?.options?.['max-file']);
    expect(Number.parseInt(writerSize, 10), 'the writer keeps more bytes per file').toBeGreaterThan(Number.parseInt(siteSize, 10));
    expect(writerFiles, 'and more files').toBeGreaterThan(Number(siteFiles));
    // The writer's rotation is the only one that differs: a copy-paste that lifted both services'
    // numbers onto the writer would still pass the per-service check above.
    expect(config.services.engine?.logging).toEqual(config.services.site?.logging);
  });

  it('gives every service the role its single-instance lock needs', () => {
    const config = loaded(REHEARSAL);
    for (const name of ['site', 'engine', 'writer']) {
      expect((config.services[name]?.environment ?? {}).BOOK_ROLE, name).toBe(name);
    }
  });

  it('starts the writer only after a healthy engine, and holds no other service behind another', () => {
    const config = loaded(REHEARSAL);
    // The writer's first request needs the internal API on 8081 to answer; `compose config` states
    // the implicit `required: true` beside the condition the file chose.
    expect(config.services.writer?.depends_on).toEqual({ engine: { condition: 'service_healthy', required: true } });
    // An engine restart must not become a site outage: the site serves readers without the engine.
    expect(config.services.site?.depends_on).toBeUndefined();
    expect(config.services.engine?.depends_on).toBeUndefined();
  });
});
