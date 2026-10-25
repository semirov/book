#!/usr/bin/env node
/**
 * scripts/dev.mjs — shared build once, then the API (tsx watch) and Vite side by side.
 *
 *   npm run dev            API on :8080, SPA on :5173 (proxy to the API)
 *   PORT=8090 npm run dev  another API port
 */

import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [];

function run(command, args, name, cwd) {
  const child = spawn(command, args, { stdio: 'inherit', env: process.env, cwd });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[dev] ${name} exited with ${code}`);
      shutdown(code);
    }
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const apiPort = process.env.PORT ?? '8080';

console.log('[dev] building @book/shared (the API imports its emitted types at runtime)');
const build = spawn(npm, ['run', 'build', '-w', '@book/shared'], { stdio: 'inherit', env: process.env });
build.on('exit', (code) => {
  if (code !== 0) shutdown(code ?? 1);
  run('npx', ['tsx', 'watch', 'server/src/index.ts'], 'api', process.cwd());
  run('npx', ['vite'], 'web', `${process.cwd()}/web`);
  console.log(`[dev] api http://127.0.0.1:${apiPort} · web http://127.0.0.1:5173`);
});
