import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LegalDenylist } from '@book/shared';
import { compilePatterns, imprintProblems } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { SITE_ROOT } from '../src/config.ts';
import { loadDenylist } from '../src/integrity/config.ts';
import { loadImprint } from '../src/imprint.ts';

const DENYLIST = join(SITE_ROOT, 'config', 'legal.denylist.json');

function shipped(): LegalDenylist {
  return JSON.parse(readFileSync(DENYLIST, 'utf8')) as LegalDenylist;
}

describe('the shipped legal config (§13.4, §6C.6)', () => {
  it('has a denylist with teeth: persons, characters, organisations and compiling patterns', () => {
    const denylist = shipped();
    expect(denylist.version).toBe(2);
    expect(denylist.persons.length).toBeGreaterThan(0);
    expect(denylist.characters.length).toBeGreaterThan(0);
    expect(denylist.organisations.length).toBeGreaterThan(0);
    expect(denylist.patterns.length).toBeGreaterThan(0);
    expect(compilePatterns(denylist.patterns).problems).toEqual([]);
    // A curated list has no duplicates: two entries for one name is a sign of a bad merge.
    for (const group of [denylist.persons, denylist.characters, denylist.organisations]) {
      expect(new Set(group.map((entry) => entry.trim().toLowerCase())).size).toBe(group.length);
    }
  });

  it('loads through the site with no problems', () => {
    const loaded = loadDenylist(DENYLIST);
    expect(loaded.problems).toEqual([]);
    expect(loaded.denylist?.persons).toEqual(shipped().persons);
  });

  it('keeps the imprint exact: one author, the copyright, no publisher', () => {
    const imprint = loadImprint(join(SITE_ROOT, 'config', 'imprint.json'));
    expect(imprintProblems(imprint)).toEqual([]);
    expect(imprint.author).toBe('Филипп Семиров');
    expect(imprint.copyright).toBe('© Филипп Семиров');
    expect(imprint.publisher).toBeNull();
  });
});
