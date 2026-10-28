/**
 * BOOK-174/ADR-043 — the cacheable prefix must not move.
 *
 * A provider caches a request by its leading bytes. If `P0` changes between two calls of the
 * same book version — a timestamp, a shuffled section, a canon line that drifted — the cache is
 * silently dead, and the bill looks like the price rose. This test is the guard.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assignmentData } from '../../src/writer/passLane.ts';
import { buildWriterPrompt, layeredMessages } from '../../src/writer/prompt.ts';
import { createHarness } from './harness.ts';

const CHAPTER = 40;

describe('the cacheable prefix', () => {
  it('is byte-identical between two builds of the same chapter in one book version', async () => {
    const harness = await createHarness();
    try {
      const assignment = harness.assignment(CHAPTER);
      const first = buildWriterPrompt({ bookRoot: harness.bookRoot, assignment: assignmentData(assignment) });
      const second = buildWriterPrompt({ bookRoot: harness.bookRoot, assignment: assignmentData(assignment) });
      expect(first.layers.p0Sha256).toBe(second.layers.p0Sha256);
      expect(Buffer.from(first.layers.p0).equals(Buffer.from(second.layers.p0))).toBe(true);
      // The request really leads with it: [system = P0][user = P1 + P2].
      const messages = layeredMessages(first);
      expect(messages[0]).toEqual({ role: 'system', content: first.layers.p0 });
      expect(messages[1]?.content.startsWith(first.layers.p1.slice(0, 40))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('is memoised per process: an edit on disk does not move it inside a run (a deploy does)', async () => {
    const harness = await createHarness();
    try {
      const assignment = harness.assignment(CHAPTER);
      const before = buildWriterPrompt({ bookRoot: harness.bookRoot, assignment: assignmentData(assignment) });
      const canon = join(harness.bookRoot, 'concept', 'CONCEPT.md');
      const original = readFileSync(canon, 'utf8');
      try {
        writeFileSync(canon, `${original}\n\nОдна новая строка канона.\n`, 'utf8');
        const after = buildWriterPrompt({ bookRoot: harness.bookRoot, assignment: assignmentData(assignment) });
        // The canon is read once per process: a deploy is the only moment a version may move it.
        expect(after.layers.p0Sha256).toBe(before.layers.p0Sha256);
      } finally {
        writeFileSync(canon, original, 'utf8');
      }
    } finally {
      await harness.close();
    }
  });

  it('never carries the chapter or the intent inside it', async () => {
    const harness = await createHarness();
    try {
      const one = buildWriterPrompt({ bookRoot: harness.bookRoot, assignment: assignmentData(harness.assignment(CHAPTER)) });
      const two = buildWriterPrompt({ bookRoot: harness.bookRoot, assignment: assignmentData(harness.assignment(CHAPTER + 1)) });
      expect(two.layers.p0Sha256).toBe(one.layers.p0Sha256);
      // …while the per-chapter layer does differ: the place is the chapter's own.
      expect(two.layers.p1).not.toBe(one.layers.p1);
    } finally {
      await harness.close();
    }
  });
});
