import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/db/db.ts';
import { sendPassEvent, startOfUtcDay } from '../../src/push/passEvent.ts';
import { createFixture, type Fixture } from '../helpers.ts';
import {
  DAY,
  HOUR,
  T0,
  claims,
  outbox,
  resetIds,
  seedChange,
  seedComment,
  seedDevice,
  seedIdentity,
  type OutboxRow,
} from './fixtures.ts';

/**
 * BOOK-189 acceptance for the engine's push hook.
 *
 * The hook is tested as what it is — rows, not sends: who is the recipient, what is said, when
 * nothing is said, and the three bounds (no device, one claim per chapter, three a day). The
 * suite runs against a real database built by the real migration, so a shape the schema does not
 * have fails here and not on the server.
 */

let fixture: Fixture | null = null;
let db: Db;

beforeEach(() => {
  resetIds();
  fixture = createFixture();
  db = fixture.db;
});

afterEach(() => {
  fixture?.close();
  fixture = null;
});

describe('sendPassEvent — landed', () => {
  it('queues one notification for the author of the filing, and only for them', () => {
    const author = seedIdentity(db, 'Аня');
    const other = seedIdentity(db, 'Боря');
    seedDevice(db, author, 'https://push.example.com/anya');
    seedDevice(db, other, 'https://push.example.com/boris');
    const filing = seedComment(db, author, 20);
    const id = seedChange(db, { chapter: 20, sourceComment: filing });

    expect(sendPassEvent(db, { kind: 'landed', chapter: 20, changeId: id }, T0)).toEqual({ queued: true, chapter: 20 });

    const rows = outbox(db);
    expect(rows).toHaveLength(1);
    const row = rows[0] as OutboxRow;
    expect(row.identity_id).toBe(author);
    expect({
      title: row.title,
      body: row.body,
      url: row.url,
      tag: row.tag,
    }).toEqual({ title: 'глава 20 написана', body: 'Бланк', url: '/ch/20', tag: 'ch20' });
    // A notification is rendered on a lock screen: no name, no identity, no capability, no ids.
    const payload = JSON.stringify({ title: row.title, body: row.body, url: row.url, tag: row.tag });
    expect(payload).not.toContain('Аня');
    expect(payload).not.toContain(author);
    expect(payload).not.toContain('push.example.com');
    expect(payload).not.toContain(filing);
    expect(payload).not.toContain(id);
    expect(row.at).toBe('2026-10-27T12:00:00Z');
    expect(row.expires_at).toBe('2026-10-28T12:00:00Z');
    expect(row.attempts).toBe(0);
    expect(row.next_at).toBe(row.at);
    expect(claims(db)).toEqual([{ identity_id: author, chapter: 20, kind: 'landed' }]);
  });

  it('speaks once per chapter, whatever is retried', () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    const id = seedChange(db, { chapter: 20, sourceComment: seedComment(db, author, 20) });

    expect(sendPassEvent(db, { kind: 'landed', chapter: 20, changeId: id }, T0)).toEqual({ queued: true, chapter: 20 });
    expect(sendPassEvent(db, { kind: 'landed', chapter: 20, changeId: id }, T0 + HOUR)).toEqual({
      queued: false,
      reason: 'duplicate',
    });
    expect(outbox(db)).toHaveLength(1);
  });

  it('notifies nobody when the step landed another chapter (a cascade neighbour)', () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    const id = seedChange(db, { chapter: 20, sourceComment: seedComment(db, author, 20) });

    expect(sendPassEvent(db, { kind: 'landed', chapter: 19, changeId: id }, T0)).toEqual({
      queued: false,
      reason: 'no-recipient',
    });
    expect(outbox(db)).toHaveLength(0);
    expect(claims(db)).toHaveLength(0);
  });

  it('notifies nobody for a change with no source comment (an operator edit)', () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    const id = seedChange(db, { chapter: 20, sourceComment: null });

    expect(sendPassEvent(db, { kind: 'landed', chapter: 20, changeId: id }, T0)).toEqual({
      queued: false,
      reason: 'no-recipient',
    });
    expect(claims(db)).toHaveLength(0);
  });

  it('notifies nobody for a change that does not exist', () => {
    expect(sendPassEvent(db, { kind: 'landed', chapter: 20, changeId: 'chg_missing' }, T0)).toEqual({
      queued: false,
      reason: 'no-recipient',
    });
  });

  it('notifies nobody for a comment that does not exist', () => {
    expect(sendPassEvent(db, { kind: 'commentDecision', commentId: 'cmt_missing', report: null }, T0)).toEqual({
      queued: false,
      reason: 'no-recipient',
    });
  });

  it('does not burn the chapter for a reader who has no device yet', () => {
    const author = seedIdentity(db, 'Аня');
    const id = seedChange(db, { chapter: 20, sourceComment: seedComment(db, author, 20) });

    expect(sendPassEvent(db, { kind: 'landed', chapter: 20, changeId: id }, T0)).toEqual({
      queued: false,
      reason: 'no-device',
    });
    expect(claims(db)).toHaveLength(0);
    expect(outbox(db)).toHaveLength(0);

    // The same chapter still speaks once the reader subscribes: nothing was claimed.
    seedDevice(db, author, 'https://push.example.com/anya', T0 + 1_000);
    expect(sendPassEvent(db, { kind: 'landed', chapter: 20, changeId: id }, T0 + 2_000)).toEqual({
      queued: true,
      chapter: 20,
    });
  });

  it('caps a reader at three a day and admits the next UTC day', () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    const ids = [21, 22, 23, 24].map((chapter) =>
      seedChange(db, { chapter, sourceComment: seedComment(db, author, chapter) }),
    );

    for (const [index, id] of ids.entries()) {
      const chapter = 21 + index;
      expect(sendPassEvent(db, { kind: 'landed', chapter, changeId: id }, T0 + index * 1_000), `chapter ${String(chapter)}`).toEqual(
        index < 3 ? { queued: true, chapter } : { queued: false, reason: 'throttled' },
      );
    }
    expect(outbox(db)).toHaveLength(3);
    expect(claims(db)).toHaveLength(3);

    // The fourth chapter is still claimable tomorrow: the cap stopped before writing a claim.
    const nextDay = startOfUtcDay(T0) + DAY + HOUR;
    expect(sendPassEvent(db, { kind: 'landed', chapter: 24, changeId: ids[3] as string }, nextDay)).toEqual({
      queued: true,
      chapter: 24,
    });
  });

  it('returns an error rather than throwing when the queue is not there', () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    const id = seedChange(db, { chapter: 20, sourceComment: seedComment(db, author, 20) });
    db.exec('DROP TABLE push_outbox');

    expect(sendPassEvent(db, { kind: 'landed', chapter: 20, changeId: id }, T0)).toEqual({
      queued: false,
      reason: 'error',
    });
    // The failed transaction wrote nothing at all, not even the claim.
    expect(claims(db)).toHaveLength(0);
  });
});

describe('sendPassEvent — decisions', () => {
  function decided(
    identityId: string,
    chapter: number,
    status: 'done' | 'void' | 'escalated' | 'failed' | 'stale' | 'processing',
    outcome: string,
  ): string {
    return seedChange(db, { chapter, sourceComment: seedComment(db, identityId, chapter), status, outcome });
  }

  it('says «написана» for an applied change', () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    const id = decided(author, 20, 'done', 'applied');
    expect(sendPassEvent(db, { kind: 'decision', changeId: id }, T0)).toEqual({ queued: true, chapter: 20 });
    expect(outbox(db)[0]?.title).toBe('глава 20 написана');
    expect(claims(db)[0]?.kind).toBe('decision');
  });

  it('says «написана» for an adapted change too', () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    const id = decided(author, 20, 'done', 'adapted');
    sendPassEvent(db, { kind: 'decision', changeId: id }, T0);
    expect(outbox(db)[0]?.title).toBe('глава 20 написана');
  });

  it('says «принята» for registered paperwork', () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    const id = decided(author, 21, 'done', 'registered');
    sendPassEvent(db, { kind: 'decision', changeId: id }, T0);
    expect(outbox(db)[0]?.title).toBe('правка по главе 21 принята');
  });

  it('says «отклонена» for a dropped change, which is the reader’s answer', () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    const dropped = decided(author, 22, 'void', 'dropped');
    sendPassEvent(db, { kind: 'decision', changeId: dropped }, T0);
    expect(outbox(db)[0]?.title).toBe('правка по главе 22 отклонена');
  });

  it('says nothing while the engine has not answered, and keeps the chapter claim', () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    // `escalated` is «остановлено — нужно решение», not a refusal; the rest are states on the way.
    // Announcing any of them would tell a reader their filing was refused while it is still alive.
    const cases: Array<{ chapter: number; status: 'escalated' | 'failed' | 'stale' | 'processing'; outcome: string }> = [
      { chapter: 23, status: 'escalated', outcome: 'budget' },
      { chapter: 24, status: 'failed', outcome: 'origin' },
      { chapter: 25, status: 'stale', outcome: 'dropped' },
      { chapter: 26, status: 'processing', outcome: 'applied' },
    ];
    for (const [index, entry] of cases.entries()) {
      const id = decided(author, entry.chapter, entry.status, entry.outcome);
      expect(
        sendPassEvent(db, { kind: 'decision', changeId: id }, T0 + index * 1_000),
        `${entry.status} must be silent`,
      ).toEqual({ queued: false, reason: 'no-recipient' });
    }
    // A `done` whose outcome this build does not know says nothing either: a guess («отклонена»)
    // would be a lie, and the chapter page is where the row's own reason is read.
    const unknown = decided(author, 27, 'done', 'rewritten');
    expect(sendPassEvent(db, { kind: 'decision', changeId: unknown }, T0 + 5_000)).toEqual({
      queued: false,
      reason: 'no-recipient',
    });
    expect(outbox(db)).toHaveLength(0);
    // Nothing was claimed, so the real answer that comes later is still speakable.
    expect(claims(db)).toHaveLength(0);

    const later = db.prepare('SELECT id FROM changes WHERE chapter = 23').get() as { id: string };
    db.prepare(`UPDATE changes SET status = 'done', outcome = 'applied' WHERE id = ?`).run(later.id);
    expect(sendPassEvent(db, { kind: 'decision', changeId: later.id }, T0 + 10_000)).toEqual({
      queued: true,
      chapter: 23,
    });
    expect(outbox(db)[0]?.title).toBe('глава 23 написана');
  });

  it('speaks for a settled premise: applied reads as the chapter, rejected as the filing', () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    const taken = seedChange(db, {
      chapter: 18,
      sourceComment: seedComment(db, author, 18),
      status: 'done',
      outcome: 'applied',
      premise: 1,
    });
    sendPassEvent(db, { kind: 'decision', changeId: taken }, T0);
    expect(outbox(db)[0]?.title).toBe('глава 18 написана');

    const refused = seedChange(db, {
      chapter: 19,
      sourceComment: seedComment(db, author, 19),
      status: 'void',
      outcome: 'dropped',
      premise: 1,
    });
    sendPassEvent(db, { kind: 'decision', changeId: refused }, T0 + 1_000);
    expect(outbox(db)[1]?.title).toBe('правка по главе 19 отклонена');
  });

  it('speaks for a filing refused at triage, with no change behind it', () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    const filing = seedComment(db, author, 24);

    // A row nobody read this way (a gate's hold, a legacy line) keeps the old sentence.
    expect(sendPassEvent(db, { kind: 'commentDecision', commentId: filing, report: null }, T0)).toEqual({
      queued: true,
      chapter: 24,
    });
    expect(outbox(db)[0]?.title).toBe('правка по главе 24 отклонена');
    expect(claims(db)).toEqual([{ identity_id: author, chapter: 24, kind: 'decision' }]);
  });

  it('speaks the reading, never «отклонена», when a disposition decided the filing (BOOK-174)', () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    const filing = seedComment(db, author, 25);

    expect(
      sendPassEvent(
        db,
        {
          kind: 'commentDecision',
          commentId: filing,
          report: {
            line1: 'ждёт решения автора',
            line2: 'потому что эта правка меняет не слово, а исход',
            line3: 'решает автор',
          },
        },
        T0,
      ),
    ).toEqual({ queued: true, chapter: 25 });
    const row = outbox(db)[0];
    // The title is the book's own word and the body is where the filing stands — no identity,
    // no comment id, no token: a lock screen is public.
    expect(row?.title).toBe('ждёт решения автора');
    expect(row?.body).toBe('решает автор');
    expect(row?.title).not.toContain('отклонена');
    expect(JSON.stringify(row)).not.toContain(filing);
  });

  it('speaks a lock as «не принято», and never as a refusal of the reader', () => {
    const author = seedIdentity(db, 'Аня');
    seedDevice(db, author, 'https://push.example.com/anya');
    const filing = seedComment(db, author, 26);

    sendPassEvent(
      db,
      {
        kind: 'commentDecision',
        commentId: filing,
        report: {
          line1: 'не принято',
          line2: 'потому что это не ваш текст',
          line3: 'сработает иначе: перескажите своими в пяти словах',
        },
      },
      T0,
    );
    expect(outbox(db)[0]?.title).toBe('не принято');
    expect(outbox(db)[0]?.title).not.toContain('отклонена');
  });
});
