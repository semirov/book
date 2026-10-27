/**
 * The stop list and the F005 denylist are one list (BOOK-61 review m1).
 *
 * `rights/stoplist.ts` keeps the curated public figures server-side, and `config/legal.denylist.json`
 * keeps the same names for the validator. Two hand-kept lists of real people drift — one gets a
 * name the other never sees, and a chapter can carry a person the rights scan would refuse. They
 * are compared here by set, not by order: a name added to either file without the other fails
 * this test, which is the whole point (the design forbids loading the file into the shipped
 * bundle, so the runtime reads one copy and a test proves it is the same copy).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PUBLIC_FIGURES } from '../../src/rights/stoplist.ts';

type Denylist = { persons?: string[]; characters?: string[] };

const DENYLIST_PATH = resolve(import.meta.dirname, '..', '..', '..', 'config', 'legal.denylist.json');

describe('the curated public figures are the denylist', () => {
  it('holds exactly the persons and characters of config/legal.denylist.json', () => {
    const denylist = JSON.parse(readFileSync(DENYLIST_PATH, 'utf8')) as Denylist;
    const expected = [...(denylist.persons ?? []), ...(denylist.characters ?? [])];
    expect(expected.length).toBeGreaterThan(0);
    // Same names, same spelling; the order is the file's own business, not a contract.
    expect([...PUBLIC_FIGURES].sort()).toEqual([...expected].sort());
    // No duplicates on either side: a name repeated in the list is a merge mistake.
    expect(new Set(PUBLIC_FIGURES).size).toBe(PUBLIC_FIGURES.length);
    expect(new Set(expected).size).toBe(expected.length);
  });
});
