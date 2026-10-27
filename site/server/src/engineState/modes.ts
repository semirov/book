/**
 * The **public** aggregate of a change's retroactive causes (BOOK-DOC-4; `style/VOICE.md`
 * §Ретроспектива).
 *
 * The mode lives on a gate finding, so the table is read here — and only the `mode` key of
 * each finding leaves this module, as an ordered list of the three fixed words. The finding
 * text and the verdict never do: a change card can say «причина установлена · оформление»
 * because the cause was filed, and nothing more about who said it.
 *
 * The filing rule is the editor's (`process/ROLE_PROMPTS.md` EDITOR #2): only an `editor`
 * verdict may file a retroactive cause, so a consultant finding that happens to carry a mode
 * is not read at all.
 */

import { RETRO_MODES, normalizeRetroMode, type RetroMode } from '@book/shared';

import type { Db } from '../db/db.ts';
import { safeJson } from './rows.ts';

/** Distinct editor modes of the given steps, in the fixed mode order; `[]` when none was filed. */
export function modesOfSteps(db: Db, stepIds: readonly string[]): RetroMode[] {
  if (stepIds.length === 0) return [];
  const placeholders = stepIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT findings FROM gate_verdicts WHERE role = 'editor' AND step_id IN (${placeholders})`,
    )
    .all(...stepIds) as Array<{ findings: string }>;

  const seen = new Set<RetroMode>();
  for (const row of rows) {
    const findings = safeJson<unknown>(row.findings);
    if (!Array.isArray(findings)) continue;
    for (const item of findings) {
      if (item === null || typeof item !== 'object') continue;
      const mode = normalizeRetroMode((item as { mode?: unknown }).mode);
      if (mode !== null) seen.add(mode);
    }
  }
  return RETRO_MODES.filter((mode) => seen.has(mode));
}
