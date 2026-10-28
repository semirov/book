/**
 * The delta of a block version (ADR-041 §2.2, BOOK-187 AC 10).
 *
 * Two layers, and both matter:
 *
 *   · the pure one — the op list is a **deterministic** function of two texts and it is *exact*:
 *     `applyDelta(prev, ops)` is the next text for every pair, an astral character counts once,
 *     and a run is always coherent (no zero-length op, no two neighbours of one kind);
 *   · the written one — the applier stores one row per **changed** version, in the version's own
 *     transaction: `source = 'patch'` when the caller supplied the span, `'diff'` when the applier
 *     computed it, nothing for an untouched block, and nothing (with a visible code) when the
 *     predecessor cannot be replayed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DELTA_DANGLING_CODE, recordBlockDelta } from '../../src/history/deltaWrite.ts';
import {
  applyDelta,
  deltaLengths,
  diffOps,
  parseDeltaOps,
  serializeDeltaOps,
} from '../../src/history/delta.ts';
import { mapBack } from '../../src/history/blame.ts';
import { applyPatch } from '../../src/ledger/applier.ts';
import { cpLength } from '../../src/ledger/spans.ts';
import { ingest } from './helpers.ts';
import { chapterFile, historyFixture, type HistoryFixture } from './helpers.ts';
import { AT, blockHashOf, ledgerFixture, seedChapter, type LedgerFixture } from '../ledger/helpers.ts';

let fixture: HistoryFixture | null = null;
let ledger: LedgerFixture | null = null;

afterEach(() => {
  fixture?.close();
  fixture = null;
  ledger?.close();
  ledger = null;
  vi.restoreAllMocks();
});

type DeltaRow = { from_ver: number; to_ver: number; source: string; ops: string; old_len: number; new_len: number; rev: number; hseq: number; change_id: string | null; step_id: string | null };

function deltaRows(db: LedgerFixture['db'], uid?: string): DeltaRow[] {
  const sql = `SELECT from_ver, to_ver, source, ops, old_len, new_len, rev, hseq, change_id, step_id
                 FROM block_deltas ${uid === undefined ? '' : 'WHERE block_uid = ?'} ORDER BY to_ver`;
  return (uid === undefined ? db.prepare(sql).all() : db.prepare(sql).all(uid)) as DeltaRow[];
}

describe('the op list is exact and deterministic', () => {
  it('turns one text into another, astral characters included', () => {
    const cases: Array<[string, string]> = [
      ['', ''],
      ['', 'Свет погас.'],
      ['Свет погас.', ''],
      ['Свет погас.', 'Свет погас.'],
      ['Смотровая площадка над рекой', 'Смотровая площадка над чёрной рекой'],
      ['Вода горела под огнями', 'Вода светилась под огнями'],
      // A surrogate pair is one code point, and a diff that counts UTF-16 units splits it.
      ['😀 дом у реки', '😀 дом у реки.'],
      ['фон 😀😀 горит', 'фон 😀 горит'],
      ['𝔘𝔫𝔦𝔠𝔬𝔡𝔢 и вода', '𝔘𝔫𝔦𝔠𝔬𝔡𝔢 и вино'],
    ];
    for (const [prev, next] of cases) {
      const ops = diffOps(prev, next);
      expect(applyDelta(prev, ops)).toBe(next);
      // The declared lengths are the code-point lengths of the two texts.
      const lengths = deltaLengths(ops);
      expect(lengths.oldLen).toBe(cpLength(prev));
      expect(lengths.newLen).toBe(cpLength(next));
      // Coherent runs only: no empty op and no two neighbours of one kind.
      for (const op of ops) expect(op[1]).toBeGreaterThan(0);
      for (let index = 1; index < ops.length; index += 1) {
        expect(ops[index]?.[0]).not.toBe(ops[index - 1]?.[0]);
      }
    }
  });

  it('is deterministic and exact over many pairs', () => {
    // A seeded generator: a property test that reorders itself on every run would be useless.
    let seed = 20_261_028;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    const alphabet = ['а', 'б', 'в', ' ', '.', '😀', 'ж'];
    const word = (): string => {
      const length = 1 + (next() % 24);
      let text = '';
      for (let index = 0; index < length; index += 1) text += alphabet[next() % alphabet.length] ?? 'а';
      return text;
    };
    for (let round = 0; round < 60; round += 1) {
      const prev = word();
      const nextText = round % 5 === 0 ? word() : `${prev} ${word()}`;
      const ops = diffOps(prev, nextText);
      expect(applyDelta(prev, ops)).toBe(nextText);
      expect(diffOps(prev, nextText)).toEqual(ops);
      expect(deltaLengths(ops)).toEqual({ oldLen: cpLength(prev), newLen: cpLength(nextText) });
    }
  });

  it('keeps a written op list readable back, and a malformed one empty', () => {
    const ops = diffOps('Смотровая площадка', 'Смотровая площадка над рекой');
    expect(parseDeltaOps(serializeDeltaOps(ops))).toEqual(ops);
    expect(parseDeltaOps('')).toEqual([]);
    expect(parseDeltaOps('не json')).toEqual([]);
    expect(parseDeltaOps('{"retain":3}')).toEqual([]);
    expect(parseDeltaOps('[["keep",3]]')).toEqual([]);
    expect(parseDeltaOps('[["insert",3]]')).toEqual([]);
  });

  it('records a wholly unrelated rewrite as one replacement, deterministically', () => {
    // Past the walk's bound the middle is recorded as delete+insert: the alignment of two texts
    // with nothing in common is not worth a quadratic walk, and the answer is the same every time.
    const prev = 'а'.repeat(2_200);
    const next = 'б'.repeat(2_100);
    const ops = diffOps(prev, next);
    expect(applyDelta(prev, ops)).toBe(next);
    expect(ops).toEqual([
      ['insert', 2_100, 'б'.repeat(2_100)],
      ['delete', 2_200],
    ]);
    expect(diffOps(prev, next)).toEqual(ops);
  });

  it('maps a position back over retain, insert and delete', () => {
    // «Смотровая площадка над рекой» → «Смотровая над чёрной рекой»: «площадка » is gone.
    const ops: Array<['retain', number] | ['insert', number, string] | ['delete', number]> = [
      ['retain', 10],
      ['delete', 9],
      ['retain', 4],
      ['insert', 7, 'чёрной '],
      ['retain', 5],
    ];
    expect(deltaLengths(ops)).toEqual({ oldLen: 28, newLen: 26 });
    // A retained character keeps its offset in the previous text…
    expect(mapBack(ops, 0)).toEqual({ kind: 'retain', pos: 0 });
    expect(mapBack(ops, 11)).toEqual({ kind: 'retain', pos: 20 });
    // …an inserted one was born at this version…
    expect(mapBack(ops, 14)).toEqual({ kind: 'insert' });
    expect(mapBack(ops, 20)).toEqual({ kind: 'insert' });
    // …and a position the ops do not cover has no origin at all.
    expect(mapBack(ops, 26)).toBeNull();
    expect(mapBack(ops, 999)).toBeNull();
  });
});

describe('the applier writes the delta with the version', () => {
  it('records one row per changed version: a patch where a span was given, a diff where it was computed', () => {
    ledger = ledgerFixture();
    const { db, dataDir } = ledger;
    const [first] = seedChapter(db, { chapter: 8, texts: ['Смотровая площадка стояла над рекой, и ветер гнал пыль.'] });
    if (first === undefined) throw new Error('fixture did not seed a block');

    const patched = applyPatch({
      db,
      dataDir,
      chapter: 8,
      patch: { mode: 'patch', edits: [{ blockId: first.id, oldText: 'пыль', newText: 'сор' }] },
      cause: { kind: 'operator', label: 'оператор' },
      nowMs: Date.parse(AT),
    });
    expect(patched.ok).toBe(true);
    const rows = deltaRows(db, first.uid);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error('no delta row');
    // A span the caller supplied: the applier did not compute this alignment, it was told it.
    expect(row.source).toBe('patch');
    expect(row.from_ver).toBe(1);
    expect(row.to_ver).toBe(2);
    expect(row.old_len).toBe(cpLength('Смотровая площадка стояла над рекой, и ветер гнал пыль.'));
    expect(row.new_len).toBe(cpLength('Смотровая площадка стояла над рекой, и ветер гнал сор.'));
    expect(applyDelta('Смотровая площадка стояла над рекой, и ветер гнал пыль.', parseDeltaOps(row.ops))).toBe(
      'Смотровая площадка стояла над рекой, и ветер гнал сор.',
    );
    // The row names the revision and the log entry it belongs to — the same ones the version names.
    const version = db
      .prepare('SELECT rev, hseq, change_id, step_id FROM block_versions WHERE block_uid = ? AND ver = 2')
      .get(first.uid) as { rev: number; hseq: number; change_id: string | null; step_id: string | null };
    expect(row.rev).toBe(version.rev);
    expect(row.hseq).toBe(version.hseq);
    expect(row.change_id).toBe(version.change_id);
    expect(row.step_id).toBe(version.step_id);
  });

  it('writes no delta when the supplied span does not describe the replayed text', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    ledger = ledgerFixture();
    const { db } = ledger;
    const [first] = seedChapter(db, { chapter: 8, texts: ['Смотровая площадка над рекой.'] });
    if (first === undefined) throw new Error('fixture did not seed a block');
    // A span that claims to have replaced text that is not where it says it is: the op list derived
    // from it would describe a change that never happened, so the version gets no delta at all.
    const bogus = {
      span_id: `${first.uid}:2:0`,
      block_id: first.id,
      block_uid: first.uid,
      from: 3,
      to: 13,
      insert: 'висела',
      removed: 'нет такого',
      cause: { kind: 'legacy', id: null },
      at: AT,
      invert: null,
    };
    const result = recordBlockDelta({
      db,
      chapter: 8,
      blockUid: first.uid,
      ver: 2,
      prevVer: 1,
      op: 'revised',
      nextText: 'Смотровая висела над рекой.',
      spans: JSON.stringify([bogus]),
      rev: 2,
      hseq: 2,
      at: AT,
      changeId: null,
      stepId: null,
    });
    expect(result).toEqual({ written: false, reason: 'delta-mismatch' });
    expect(deltaRows(db, first.uid)).toHaveLength(0);
    expect(warn.mock.calls.some((call) => String(call[0]).includes(DELTA_DANGLING_CODE))).toBe(true);
  });

  it('labels an ingest rewrite as a computed diff, never as a patch', () => {
    fixture = historyFixture();
    const text = chapterFile(12, ['Смотровая площадка стояла над рекой, и ветер гнал по ней сухую пыль.']);
    const created = ingest(fixture, 'ch12.md', text);
    expect(created.created).toEqual([12]);
    const uid = (
      fixture.db.prepare('SELECT block_uid FROM block_versions WHERE chapter = 12 AND op = ?').get('introduced') as {
        block_uid: string;
      }
    ).block_uid;

    const rewritten = text.replace('и ветер гнал по ней сухую пыль', 'а вода несла по ней мокрый снег');
    const second = ingest(fixture, 'ch12.md', rewritten);
    expect(second.revised).toEqual([12]);
    const rows = deltaRows(fixture.db, uid);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('diff');
    const previous = fixture.db.prepare('SELECT text FROM block_versions WHERE block_uid = ? AND ver = 1').get(uid) as {
      text: string;
    };
    const next = fixture.db.prepare('SELECT text FROM blocks WHERE chapter = 12 AND id = ?').get(
      (
        fixture.db.prepare('SELECT block_id FROM block_versions WHERE block_uid = ? AND ver = 2').get(uid) as {
          block_id: string;
        }
      ).block_id,
    ) as { text: string };
    expect(applyDelta(previous.text, parseDeltaOps(rows[0]?.ops ?? '[]'))).toBe(next.text);
  });

  it('writes nothing for an untouched block, and nothing twice for one version', () => {
    ledger = ledgerFixture();
    const { db, dataDir } = ledger;
    const [first, second] = seedChapter(db, {
      chapter: 8,
      texts: ['Смотровая площадка стояла над рекой.', 'Внизу проходили баржи и вода блестела.'],
    });
    if (first === undefined || second === undefined) throw new Error('fixture did not seed two blocks');

    const result = applyPatch({
      db,
      dataDir,
      chapter: 8,
      patch: { mode: 'patch', edits: [{ blockId: first.id, oldText: 'стояла', newText: 'висела' }] },
      cause: { kind: 'operator', label: 'оператор' },
      nowMs: Date.parse(AT),
    });
    expect(result.ok).toBe(true);
    // The untouched paragraph got no version and therefore no delta.
    expect(deltaRows(db, second.uid)).toHaveLength(0);
    expect(deltaRows(db, first.uid)).toHaveLength(1);

    // A re-run over an existing (block_uid, to_ver) inserts nothing (ADR-041: ON CONFLICT DO NOTHING),
    // and it cannot change the decision the first write made: the row is the one that stands.
    const row = deltaRows(db, first.uid)[0];
    if (row === undefined) throw new Error('no delta row');
    const again = recordBlockDelta({
      db,
      chapter: 8,
      blockUid: first.uid,
      ver: 2,
      prevVer: 1,
      op: 'revised',
      nextText: 'Смотровая площадка висела над рекой.',
      // A computed diff this time, not the span the first write was given: the stored row must not
      // flip from `patch` to `diff` because a later pass replayed the same version.
      spans: '[]',
      rev: 2,
      hseq: 1,
      at: AT,
      changeId: null,
      stepId: null,
    });
    expect(again.written).toBe(true);
    expect(deltaRows(db, first.uid)).toHaveLength(1);
    expect(deltaRows(db, first.uid)[0]).toEqual(row);
  });

  it('writes no delta for a version whose predecessor cannot be replayed, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    ledger = ledgerFixture();
    const { db, dataDir } = ledger;
    const [first] = seedChapter(db, { chapter: 8, texts: ['Смотровая площадка стояла над рекой.'] });
    if (first === undefined) throw new Error('fixture did not seed a block');

    // A version the ledger cannot replay: no checkpoint text, no spans, and no delta either —
    // the shape a pre-delta install left behind.
    db.prepare(
      `INSERT INTO block_versions
         (block_uid, ver, chapter, rev, hseq, block_id, text_hash, chars, op, prev_ver, replaced_by,
          change_id, step_id, actor_kind, actor_label, identity_id, at, spans, text)
       VALUES (?, 2, 8, 2, 2, ?, ?, 30, 'revised', 1, NULL, NULL, NULL, 'writer', 'печатник', NULL, ?, '[]', '')`,
    ).run(first.uid, first.id, 'deadbeef', AT);
    db.prepare('UPDATE chapters SET rev = 2 WHERE n = 8').run();

    const result = applyPatch({
      db,
      dataDir,
      chapter: 8,
      patch: { mode: 'patch', edits: [{ blockId: first.id, oldText: 'стояла', newText: 'висела' }] },
      cause: { kind: 'operator', label: 'оператор' },
      nowMs: Date.parse(AT),
    });
    expect(result.ok).toBe(true);
    // The version exists; the delta does not, because inventing an op list is the one lie here.
    expect(db.prepare('SELECT COUNT(*) AS n FROM block_versions WHERE block_uid = ?').get(first.uid)).toEqual({ n: 3 });
    expect(deltaRows(db, first.uid)).toHaveLength(0);
    expect(warn.mock.calls.some((call) => String(call[0]).includes(DELTA_DANGLING_CODE))).toBe(true);
  });
});

describe('the delta row is code points, not UTF-16 units', () => {
  it('counts an astral character once on both sides', () => {
    ledger = ledgerFixture();
    const { db, dataDir } = ledger;
    const before = 'Фонарь 😀 стоял у воды.';
    const [first] = seedChapter(db, { chapter: 8, texts: [before] });
    if (first === undefined) throw new Error('fixture did not seed a block');
    expect(blockHashOf(before)).toBe(first.hash);

    const result = applyPatch({
      db,
      dataDir,
      chapter: 8,
      patch: { mode: 'patch', edits: [{ blockId: first.id, oldText: 'стоял', newText: 'гас' }] },
      cause: { kind: 'operator', label: 'оператор' },
      nowMs: Date.parse(AT),
    });
    expect(result.ok).toBe(true);
    const row = deltaRows(db, first.uid)[0];
    if (row === undefined) throw new Error('no delta row');
    // `before.length` in UTF-16 is two more than its code-point length, and the row is in code points.
    expect(row.old_len).toBe(cpLength(before));
    expect(row.old_len).not.toBe(before.length);
    expect(row.new_len).toBe(cpLength('Фонарь 😀 гас у воды.'));
  });
});
