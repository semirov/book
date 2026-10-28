/**
 * BOOK-158 — a refusal teaches: it says why in a sentence, offers an actionable hint and
 * leaves a way back.
 *
 * The hint is chosen from the stored verdict columns, never from the text of the reason (a
 * model can write a reason; a string test is not a verdict — `repo.ts` `refusalOf`). Three
 * gates refuse, and each owes the reader a different next step: name the source (B), say one
 * event this chapter does not have yet (C), take the instruction out (A). A refusal with no
 * gate behind it still gets a sentence rather than «попробуйте иначе».
 *
 * These fixtures are rows in a temp database — never the production data dir.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { HINT_MAX_CHARS, refusalHint } from '../../src/comments/attempts.ts';
import { insertComment, listCommentRows, readCommentRow, toCommentDto } from '../../src/comments/repo.ts';
import { openDatabase, type Db } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { upsertIdentity } from '../../src/db/repo/identities.ts';

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);
const ISO = (ms: number): string => new Date(ms).toISOString();
const AUDITOR_LINE = 'вне книги: этот мир не просит чудес';

let db: Db | null = null;
let identityId = '';

afterEach(() => {
  db?.close();
  db = null;
});

function boot(): Db {
  const opened = openDatabase(':memory:');
  migrate(opened);
  identityId = upsertIdentity(opened, {
    yandexSub: 'yandex-1001',
    displayName: 'Аня',
    at: ISO(T0),
  }).id;
  db = opened;
  return opened;
}

type Seed = {
  status: 'new' | 'rejected' | 'quarantined';
  rightsVerdict?: 'CLEAR' | 'REFUSED';
  rightsRule?: string;
  auditVerdict?: 'FITS' | 'OFF';
  held?: boolean;
  decidedAt?: string | null;
  reason?: string | null;
};

/** One filing row with the verdict columns the gate would have written. */
function seed(database: Db, id: string, fields: Seed): string {
  insertComment(database, {
    id,
    identityId,
    chapter: 8,
    blockId: null,
    blockIndex: null,
    baseRev: 0,
    quote: null,
    prefix: null,
    suffix: null,
    author: 'Аня',
    body: 'Замечание к главе, которое не приняли.',
    proposedText: null,
    interventionKind: null,
    bodySha: `sha-${id}`,
    flags: [],
    ipHash: 'a'.repeat(64),
    status: fields.status,
    guard: null,
    reason: fields.reason ?? null,
    createdAt: ISO(T0),
    idemKey: null,
  });
  if (fields.rightsVerdict !== undefined) {
    database
      .prepare(`UPDATE comments SET rights_verdict = ?, rights_rule = ?, rights_at = ?, rights_source = 'scan' WHERE id = ?`)
      .run(fields.rightsVerdict, fields.rightsRule ?? null, ISO(T0), id);
  }
  if (fields.auditVerdict !== undefined) {
    database
      .prepare(`UPDATE comments SET audit_verdict = ?, audited_at = ? WHERE id = ?`)
      .run(fields.auditVerdict, ISO(T0), id);
  }
  if (fields.held === true) {
    database.prepare(`UPDATE comments SET held_rule = 'INJ-IGNORE', held_by = 'filter', held_at = ? WHERE id = ?`).run(ISO(T0), id);
  }
  if (fields.decidedAt !== undefined) {
    database.prepare('UPDATE comments SET decided_at = ? WHERE id = ?').run(fields.decidedAt, id);
  }
  return id;
}

function dto(database: Db, id: string) {
  const row = readCommentRow(database, id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return toCommentDto(database, row, T0);
}

describe('a refusal renders a reason and an actionable hint for each gate', () => {
  it('names the source for a quote, the reader’s own words for a paraphrase', () => {
    const database = boot();
    const quote = seed(database, 'cmt_quote', {
      status: 'rejected',
      rightsVerdict: 'REFUSED',
      rightsRule: 'RIGHTS-QUOTE',
      decidedAt: ISO(T0),
      reason: 'не принято: чужая цитата без источника',
    });
    const paraphrase = seed(database, 'cmt_paraphrase', {
      status: 'rejected',
      rightsVerdict: 'REFUSED',
      rightsRule: 'RIGHTS-PARAPHRASE',
      decidedAt: ISO(T0),
      reason: 'не принято: пересказ чужого текста без источника',
    });

    const quoteDto = dto(database, quote);
    expect(quoteDto).toMatchObject({ status: 'rejected', refusal: 'rights' });
    expect(quoteDto.hint).toBe('приведите название и дату источника цитаты');

    const paraphraseDto = dto(database, paraphrase);
    expect(paraphraseDto.refusal).toBe('rights');
    expect(paraphraseDto.hint).toBe('перескажите своими словами, без чужой формулировки');
  });

  it('asks for one event this chapter lacks when the auditor refused', () => {
    const database = boot();
    const id = seed(database, 'cmt_auditor', {
      status: 'rejected',
      auditVerdict: 'OFF',
      decidedAt: ISO(T0),
      reason: AUDITOR_LINE,
    });

    const row = dto(database, id);
    expect(row).toMatchObject({ status: 'rejected', refusal: 'auditor', reason: AUDITOR_LINE });
    expect(row.hint).toBe('сформулируйте одно событие этой главы, которого ещё нет в тексте');
  });

  it('asks the reader to take an instruction out of a held filing', () => {
    const database = boot();
    const id = seed(database, 'cmt_held', { status: 'quarantined', held: true });

    const row = dto(database, id);
    expect(row).toMatchObject({ status: 'quarantined', refusal: 'held' });
    expect(row.hint).toBe('уберите из текста указания в адрес модели');
    // A hold is not a decision: nothing to wait out, and nothing the reader may revise yet.
    expect(row.revise).toMatchObject({ allowed: false, blocked: null, at: null });
  });

  it('never leaves a refusal without a sentence, and never prints a code', () => {
    const database = boot();
    const generic = seed(database, 'cmt_generic', { status: 'rejected', decidedAt: ISO(T0), reason: 'не по делу' });
    const accepted = seed(database, 'cmt_accepted', { status: 'new' });
    const quote = seed(database, 'cmt_quote', {
      status: 'rejected',
      rightsVerdict: 'REFUSED',
      rightsRule: 'RIGHTS-QUOTE',
      decidedAt: ISO(T0),
      reason: 'не принято: чужая цитата без источника',
    });
    const auditor = seed(database, 'cmt_auditor', {
      status: 'rejected',
      auditVerdict: 'OFF',
      decidedAt: ISO(T0),
      reason: AUDITOR_LINE,
    });

    const refused = dto(database, generic);
    expect(refused.refusal).toBeNull();
    expect(refused.hint).toBe('переформулируйте так, чтобы это было одним событием этой главы');
    expect(dto(database, accepted).hint).toBeNull();

    // Every hint is one line: short enough to sit beside the refusal, and free of rule ids.
    for (const hint of [
      refused.hint,
      dto(database, quote).hint,
      dto(database, auditor).hint,
    ]) {
      expect(hint).not.toBeNull();
      expect((hint as string).length).toBeLessThanOrEqual(HINT_MAX_CHARS);
      expect(hint as string).not.toMatch(/[A-Z]{2,}_[A-Z]+/u);
      expect(hint as string).not.toContain('RIGHTS');
    }
  });

  it('chose the hint from the verdict, not from the reason text', () => {
    // A model may write any reason; a row whose stored verdict is B's is B's refusal whatever
    // the sentence says, and one with no verdict gets no gate's hint.
    expect(
      refusalHint({ status: 'rejected', refusal: 'rights', rights_rule: 'RIGHTS-PARAPHRASE' }),
    ).toBe('перескажите своими словами, без чужой формулировки');
    expect(refusalHint({ status: 'rejected', refusal: null, rights_rule: 'RIGHTS-QUOTE' })).toBe(
      'переформулируйте так, чтобы это было одним событием этой главы',
    );
    expect(refusalHint({ status: 'quarantined', refusal: 'held', rights_rule: 'RIGHTS-QUOTE' })).toBe(
      'уберите из текста указания в адрес модели',
    );
  });
});

describe('the revise state a refusal carries', () => {
  it('names the cooldown while it runs, and the door once it passes', () => {
    const database = boot();
    const id = seed(database, 'cmt_cooldown', {
      status: 'rejected',
      auditVerdict: 'OFF',
      decidedAt: ISO(T0),
      reason: AUDITOR_LINE,
    });

    // 5 minutes into the 10-minute cooldown.
    const row = readCommentRow(database, id);
    const during = toCommentDto(database, row!, T0 + 5 * 60_000);
    expect(during.revise).toEqual({
      allowed: false,
      at: ISO(T0 + 10 * 60_000),
      attemptsLeft: 3,
      closed: false,
      blocked: 'cooldown',
    });

    const after = toCommentDto(database, row!, T0 + 11 * 60_000);
    expect(after.revise).toMatchObject({ allowed: true, blocked: null, attemptsLeft: 3 });
  });
});

/**
 * The driver, wrapped so a test can see the statements a read issued while the real connection
 * still answers them. `prepare` is the one door every query goes through.
 */
function counting(database: Db): { db: Db; statements: () => string[] } {
  const statements: string[] = [];
  const proxy = new Proxy(database, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          statements.push(sql);
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db: proxy, statements: () => statements };
}

describe('a public list asks the attempt ledger only about a refused row', () => {
  it('does not run the three counts for every accepted filing', () => {
    const database = boot();
    for (let index = 0; index < 5; index += 1) seed(database, `cmt_ok_${String(index)}`, { status: 'new' });
    const refused = seed(database, 'cmt_refused', {
      status: 'rejected',
      auditVerdict: 'OFF',
      decidedAt: ISO(T0),
      reason: AUDITOR_LINE,
    });

    const counted = counting(database);
    const rows = listCommentRows(counted.db, { chapter: 8, limit: 50 });
    expect(rows).toHaveLength(6);
    const dtos = rows.map((row) => toCommentDto(counted.db, row, T0));

    // Three counts (filing, identity, network) for the one row a revision could reopen.
    const attemptReads = counted.statements().filter((sql) => sql.includes('comment_attempts'));
    expect(attemptReads).toHaveLength(3);

    // The accepted rows still carry the shape the page reads, and the refused one keeps the
    // exact state the ledger gives it.
    const accepted = dtos.find((row) => row.id === 'cmt_ok_0');
    expect(accepted?.revise).toEqual({
      allowed: false,
      at: null,
      attemptsLeft: 3,
      closed: false,
      blocked: null,
    });
    expect(dtos.find((row) => row.id === refused)?.revise).toMatchObject({
      allowed: false,
      at: ISO(T0 + 10 * 60_000),
      blocked: 'cooldown',
    });
  });
});
