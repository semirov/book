/**
 * lib/cdp.mjs — a Chrome DevTools Protocol client over the runtime's own `WebSocket`.
 *
 * No Playwright, no puppeteer: the harness drives the browser the way the protocol defines it —
 * one page target, numbered calls, subscribed events. Just enough for the pass frames: navigate,
 * evaluate, screenshot.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CANDIDATES = [
  'Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'Library/Caches/ms-playwright/chromium_headless_shell-1148/chrome-mac/headless_shell',
];

/** The Playwright-managed Chromium (full or headless shell), or a failure that says where. */
export function chromiumBinary() {
  for (const candidate of CANDIDATES) {
    const path = join(homedir(), candidate);
    if (existsSync(path)) return path;
  }
  throw new Error('no Chromium in ~/Library/Caches/ms-playwright (chromium-1148 or chromium_headless_shell-1148)');
}

export async function waitForUrl(url, timeoutMs, what) {
  const started = Date.now();
  for (;;) {
    try {
      const answer = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (answer.ok) return answer;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`${what} did not answer at ${url} within ${timeoutMs} ms`);
    await sleep(250);
  }
}

export async function portIsFree(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(700) });
    return false;
  } catch {
    return true;
  }
}

/** A child whose output is kept (bounded) for the failure report; killed as a process group. */
export function spawnLogged(command, args, options) {
  const child = spawn(command, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  const collect = (chunk) => {
    child.output += chunk.toString();
    if (child.output.length > 200_000) child.output = child.output.slice(-100_000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  // A spawn that fails outright emits 'error' and no 'exit': collected, never an unhandled crash.
  child.on('error', (error) => collect(`spawn failed: ${error.message}`));
  return child;
}

export function killTree(child) {
  if (child === undefined || child === null || child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

/** Launch headless Chromium with a scratch profile and answer the browser-level endpoint. */
export async function launchChromium({ binary, cdpPort, profileDir, windowSize }) {
  // The profile directory must exist: `spawn` fails outright on a missing cwd.
  mkdirSync(profileDir, { recursive: true });
  const child = spawnLogged(binary, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${windowSize}`,
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    'about:blank',
  ], { cwd: profileDir });
  await waitForUrl(`http://127.0.0.1:${cdpPort}/json/version`, 30_000, 'Chromium CDP');
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const page = targets.find((target) => target.type === 'page');
  if (page === undefined) throw new Error('Chromium opened no page target');
  return { child, pageUrl: page.webSocketDebuggerUrl };
}

/** One page target: numbered calls with a timeout, and event subscriptions. */
export class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(event.data);
      if (frame.id !== undefined) {
        const entry = this.pending.get(frame.id);
        this.pending.delete(frame.id);
        if (entry === undefined) return;
        if (frame.error) entry.reject(new Error(JSON.stringify(frame.error)));
        else entry.resolve(frame.result ?? {});
        return;
      }
      for (const listener of this.listeners.get(frame.method) ?? []) listener(frame.params ?? {});
    });
  }

  static async open(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      socket.addEventListener('open', resolveOpen, { once: true });
      socket.addEventListener('error', () => rejectOpen(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new Cdp(socket);
  }

  on(method, listener) {
    const held = this.listeners.get(method) ?? [];
    held.push(listener);
    this.listeners.set(method, held);
  }

  send(method, params = {}) {
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new Error(`${method} did not answer in 10 s`));
      }, 10_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveCall(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectCall(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}
