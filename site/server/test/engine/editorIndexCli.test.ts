import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { SITE_ROOT } from '../../src/config.ts';
import { buildControl } from '../../src/engine/control.ts';
import type { GateAssignment } from '../../src/engine/gates.ts';
import { createEngineFixture } from './helpers.ts';

const exec = promisify(execFile);
const TOKEN = 'test-token';

describe('the driver’s editor assignment carries the slice path (BOOK-18 §2, IFACE)', () => {
  it('prints `indexSlice` from the real CLI, with the same command and exit code', async () => {
    const fixture = createEngineFixture();
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    try {
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      const chapter = assignment.chapter as number;
      fixture.engine.start(assignment.leaseId);
      fixture.writeChapterBlocks(chapter, `Глава ${chapter}`, ['Инженер Ковалёв вошёл в комнату.']);
      fixture.engine.land(assignment.leaseId);

      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address() as AddressInfo;
      const { stdout, stderr } = await exec('node', ['bin/engine.mjs', 'next', '--role', 'editor'], {
        cwd: SITE_ROOT,
        env: {
          ...process.env,
          ENGINE_URL: `http://127.0.0.1:${address.port}`,
          ENGINE_TOKEN: TOKEN,
        },
      });
      expect(stderr).toBe('');
      const gate = JSON.parse(stdout) as GateAssignment;
      expect(gate.indexSlice).toBe(
        join(fixture.dataDir, 'index', 'slices', `ch${String(chapter).padStart(2, '0')}.json`),
      );
    } finally {
      await app.close();
      fixture.close();
    }
  });
});
