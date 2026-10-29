/**
 * BOOK-217 — the recovery rule both deploy drivers call (`lib.sh:recovery_choice` / `recovery_line`).
 *
 * The rule is one function pair, not a sentence typed once per driver: `1 1` is a roll-forward,
 * `1 0` a dump-restore, `0 *` the ordinary image rollback — and each prints exactly one fixed line
 * an operator (and the audit) can match on. The fact is TRI-state: a read that failed is `unknown`,
 * never "not migrated", because both ways of rounding it are unsafe (an image swap on a volume that
 * may have migrated is the crash loop; a restore on a volume that may not have is an old copy over
 * the live book). `unknown` has its own outcome and its own sentence: `none`. Driven through bash
 * the way `deploy.sh` sources the lib, so the sentence under test is the one prod prints.
 */

import { describe, expect, it } from 'vitest';

import { lib } from './deployHarness.ts';

/** The fact the drill reads from the volume: the boot's own pre-migration dump. */
const MOVED = 'the boot dumped v29 before migrating (backups/pre-v29-20261029T085300Z.db)';

/** The detail an unknown fact carries instead. */
const UNKNOWN = 'the listing of backups/ after up failed, so whether the boot migrated the volume cannot be known';

describe('recovery_choice: one rule, four outcomes', () => {
  it('picks roll-forward when migrated and serving, dump-restore when migrated and silent, image-rollback otherwise', async () => {
    const { code, out } = await lib(
      [
        `printf '%s\\n' "$(recovery_choice 1 1)"`,
        `printf '%s\\n' "$(recovery_choice 1 0)"`,
        `printf '%s\\n' "$(recovery_choice 0 1)"`,
        `printf '%s\\n' "$(recovery_choice 0 0)"`,
        // The tri-state: an unread fact is `none`, never a silent image rollback on a volume that may
        // have migrated (that swap is the SCHEMA_FUTURE crash loop) and never a silent restore (that
        // would write an old dump over the live book).
        `printf '%s\\n' "$(recovery_choice unknown 0)"`,
        `printf '%s\\n' "$(recovery_choice unknown 1)"`,
        `printf '%s\\n' "$(recovery_choice '' '')"`,
      ].join('\n'),
    );

    expect(code, out).toBe(0);
    expect(out.trim().split('\n')).toEqual([
      'roll-forward',
      'dump-restore',
      'image-rollback',
      'image-rollback',
      'none',
      'none',
      'none',
    ]);
  });
});

describe('recovery_line: the four fixed sentences, one line each', () => {
  it('prints the fact it was decided from, and nothing else', async () => {
    const { code, out } = await lib(
      [
        `printf '%s\\n' "$(recovery_line roll-forward '${MOVED}')"`,
        `printf '%s\\n' "$(recovery_line dump-restore '${MOVED}')"`,
        `printf '%s\\n' "$(recovery_line image-rollback 'no new dump in backups/, so the boot ran no DDL')"`,
        `printf '%s\\n' "$(recovery_line none '${UNKNOWN}')"`,
      ].join('\n'),
    );

    expect(code, out).toBe(0);
    const lines = out.trim().split('\n');
    expect(lines, out).toHaveLength(4);
    expect(lines[0]).toBe(
      `recovery: roll-forward — a migration ran (${MOVED}), so the previous image is NOT put back; the new image keeps serving (degraded, alive)`,
    );
    expect(lines[1]).toBe(
      `recovery: dump-restore — a migration ran (${MOVED}) and the new image does not serve, so the pre-deploy dump was restored over book.db and the previous image runs`,
    );
    expect(lines[2]).toBe(
      'recovery: image-rollback — no migration ran (no new dump in backups/, so the boot ran no DDL), so the previous image is restored on the same schema',
    );
    // The fourth sentence says what did NOT happen — the state of a run that could not decide.
    expect(lines[3]).toBe(
      `recovery: none — ${UNKNOWN}; nothing was rolled back and nothing was restored, a human must look`,
    );
  });

  it('refuses a choice that is none of the four: no line is invented', async () => {
    const { code, out } = await lib(
      'if recovery_line bogus >/dev/null; then echo accepted; else echo refused; fi',
    );

    expect(code, out).toBe(0);
    expect(out.trim()).toBe('refused');
  });
});
