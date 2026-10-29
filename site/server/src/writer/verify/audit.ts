/**
 * `writer --audit-samples [N]` — the safeguard (BOOK-173, BOOK-DOC-80 §"The safeguard").
 *
 * A `local only` change was read by the local judge only. Every 10th one, and the first after a
 * writer boot, is queued at close (`change_plans.sample_requested = 1`) and drained here: the
 * **editor** reads the chapter with the real prompt (`buildGatePrompt` — the same bytes the full
 * pair would send), and its verdict is compared with the Tier-1 word the change was closed on.
 *
 * Three outcomes, three records:
 *
 *   · agreement (`HOLDS`/`HOLDS`) → `sample_verdict = ok`, nothing else;
 *   · disagreement (the editor found a `GAP` where Tier 1 said `HOLDS`) → an alert, the finding
 *     attached to the change, `sample_verdict = gap`, and the row marked `local_only_rechecked`:
 *     the reader's record stops claiming a clean read;
 *   · the editor itself fails → `sample_verdict = error`, the sample **stays queued** (a failed
 *     read is not a clean read), and a second failure in one run raises its own alert.
 *
 * Two disagreements in any 20 samples raise a second alert: the judge is drifting, not the change.
 *
 * **An alert is raised once per event.** `--audit-samples` is run on a schedule, and a read that
 * keeps failing (the editor is down) or a window that keeps holding two gaps is the *same* fact on
 * the second run, not a new one. So the last alert stands in a `meta` watermark
 * (`writer.audit`): a sample row that already raised a disagreement or a failure raises nothing
 * again, and the drift alert fires on a crossing (the window reaching two gaps), not on every run
 * that still sees them.
 *
 * The interface, in one place: `0` drained (nothing to do is drained), `1` something was flagged,
 * `2` the run could not run (no database, nothing readable, every sample failed).
 */

import type { Db } from '../../db/db.ts';
import type { EngineAlert } from '../../engine/types.ts';
import { recordAlertRow } from '../../engine/alerts.ts';
import { getMeta, setMeta } from '../../engine/rows.ts';
import { parseGateAnswer, buildGatePrompt } from '../gates.ts';
import { readChapterRows, textViewsOf } from '../../engine/text.ts';
import {
  attachFinding,
  markRechecked,
  recentSampleVerdicts,
  recordSample,
  sampleAt,
  sampleQueue,
} from '../../ledger/graph/verification.ts';
import type { WriterConfig } from '../config.ts';
import type { ProviderCall } from '../passLane.ts';
import { agreement, DEFAULT_AUDIT_SAMPLES, DRIFT_WINDOW, driftDetected, type SampleVerdict } from './samples.ts';

export type AuditInput = {
  db: Db;
  config: WriterConfig;
  bookRoot: string;
  provider: ProviderCall;
  log: (line: string) => void;
  now: () => number;
  /** `--audit-samples N`; `DEFAULT_AUDIT_SAMPLES` otherwise. */
  limit?: number;
};

/** The finding the audit attaches: the editor's own words, bounded, never the whole answer. */
function findingLine(parsed: { severity: string; location: string; defect: string; fix: string }): string {
  return `${parsed.severity} · ${parsed.location} · ${parsed.defect} · ${parsed.fix}`.slice(0, 400);
}

/** `meta` key of the alert watermark: what this audit has already alerted, so it alerts once. */
export const AUDIT_WATERMARK_KEY = 'writer.audit';
/** How many rows the watermark remembers: far more than any one run's queue, bounded on purpose. */
const WATERMARK_KEEP = 100;

type AuditWatermark = {
  /** Plan rows a disagreement was already alerted for. */
  samples: string[];
  /** Plan rows a failed read was already alerted for. */
  errors: string[];
  /** Gaps in the window when the drift alert last stood; `null` while the window is clean. */
  driftGaps: number | null;
};

function idsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

function watermarkOf(db: Db): AuditWatermark {
  const raw = getMeta(db, AUDIT_WATERMARK_KEY);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Partial<AuditWatermark> | null;
      if (parsed !== null && typeof parsed === 'object') {
        return {
          samples: idsOf(parsed.samples),
          errors: idsOf(parsed.errors),
          driftGaps: typeof parsed.driftGaps === 'number' ? parsed.driftGaps : null,
        };
      }
    } catch {
      // A watermark nobody can read is no watermark: alerting again beats never alerting.
    }
  }
  return { samples: [], errors: [], driftGaps: null };
}

function writeWatermark(db: Db, watermark: AuditWatermark): void {
  setMeta(db, AUDIT_WATERMARK_KEY, JSON.stringify(watermark));
}

/** Remember the rows an alert was raised for, keeping the newest `WATERMARK_KEEP` and no repeats. */
function remember(known: readonly string[], added: readonly string[]): string[] {
  const next = [...known];
  for (const id of added) if (!next.includes(id)) next.push(id);
  return next.slice(-WATERMARK_KEEP);
}

function alertOf(input: AuditInput, detail: string, changeId: string | null): EngineAlert {
  return { kind: 'local_only', at: sampleAt(input.now()), changeId, cascadeId: null, stepId: null, detail: detail.slice(0, 400) };
}

export async function runAuditSamples(input: AuditInput): Promise<number> {
  const limit = Math.max(1, Math.trunc(input.limit ?? DEFAULT_AUDIT_SAMPLES));
  const watermark = watermarkOf(input.db);
  const queue = sampleQueue(input.db, limit);
  if (queue.length === 0) {
    input.log('[writer] аудит образцов: очередь пуста');
    // Nothing was read, so nothing new happened — but a window that stopped drifting must be able
    // to raise its alert when it next crosses.
    if (!driftDetected(recentSampleVerdicts(input.db, DRIFT_WINDOW))) {
      watermark.driftGaps = null;
      writeWatermark(input.db, watermark);
    }
    return 0;
  }

  let flagged = false;
  let errors = 0;
  let drained = 0;
  /** The rows this run could not read: the ones a failure alert has not been raised for yet. */
  const failed: string[] = [];
  for (const sample of queue) {
    const chapter = readChapterRows(input.db, sample.chapter);
    if (!chapter.exists) {
      input.log(`[writer] аудит ${sample.changeId}: текста главы ${String(sample.chapter)} нет — образец остаётся в очереди`);
      recordSample(input.db, sample.planRowId, 'error', sampleAt(input.now()));
      errors += 1;
      failed.push(sample.planRowId);
      continue;
    }
    // The sample is a gate's own reading, so it quotes the rows exactly as a gate does: the
    // chapter that landed, and its neighbours through the same lookup (`POST /internal/text`).
    const views = new Map(textViewsOf(input.db, [sample.chapter - 1, sample.chapter, sample.chapter + 1]).map((view) => [view.n, view]));
    const chapterText = (n: number) => views.get(n) ?? { n, title: null, exists: false, basis: false, chars: 0, text: '' };
    const prompt = buildGatePrompt({
      bookRoot: input.bookRoot,
      role: 'editor',
      chapter: sample.chapter,
      assignment: { chapter: sample.chapter, pass: 'audit-sample', role: 'editor', cycle: 0, source: 'audit-sample' },
      landedText: chapter.text,
      chapterText,
      indexSlice: null,
      refusal: null,
    });
    let answer;
    try {
      answer = await input.provider({
        endpoint: input.config.endpoint,
        apiKey: input.config.apiKey,
        apiModel: input.config.apiModel,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        maxTokens: input.config.gateTokens,
        timeoutMs: input.config.timeoutMs,
      });
    } catch (error) {
      input.log(`[writer] аудит ${sample.changeId}: редактор не ответил (${error instanceof Error ? error.message.slice(0, 120) : 'ошибка'}) — образец в очереди`);
      recordSample(input.db, sample.planRowId, 'error', sampleAt(input.now()));
      errors += 1;
      failed.push(sample.planRowId);
      continue;
    }
    const parsed = parseGateAnswer(answer.text, 'editor');
    if (!parsed.ok) {
      input.log(`[writer] аудит ${sample.changeId}: ответ редактора не разобран (${parsed.reason.slice(0, 160)}) — образец в очереди`);
      recordSample(input.db, sample.planRowId, 'error', sampleAt(input.now()));
      errors += 1;
      failed.push(sample.planRowId);
      continue;
    }

    const verdict: SampleVerdict = agreement(parsed.verdict, sample.tier1Verdict);
    recordSample(input.db, sample.planRowId, verdict, sampleAt(input.now()));
    drained += 1;
    if (verdict === 'ok') {
      input.log(`[writer] аудит ${sample.changeId}: местный судья и редактор согласны (HOLDS)`);
      continue;
    }
    const finding = parsed.findings[0];
    const line = finding === undefined ? 'редактор нашёл разрыв' : findingLine(finding);
    attachFinding(input.db, sample.changeId, line, sampleAt(input.now()));
    markRechecked(input.db, sample.planRowId);
    // One disagreement, one alert: a re-run over the same rows is the same finding.
    if (!watermark.samples.includes(sample.planRowId)) {
      recordAlertRow(input.db, alertOf(input, `образец ${sample.changeId}: местный судья сказал HOLDS, редактор — GAP: ${line}`, sample.changeId));
      watermark.samples = remember(watermark.samples, [sample.planRowId]);
    }
    flagged = true;
    input.log(`[writer] аудит ${sample.changeId}: расхождение — ${line}`);
  }

  // A repeated failure is not «no news», but a failure already reported is: the editor never read
  // the samples it was given, and the alert is about that fact, not about this run.
  const fresh = failed.filter((planRowId) => !watermark.errors.includes(planRowId));
  if (errors >= 2 && fresh.length > 0) {
    recordAlertRow(input.db, alertOf(input, `аудит образцов: редактор не прочитал ${String(errors)} образцов — проверка не состоялась`, null));
    watermark.errors = remember(watermark.errors, fresh);
    flagged = true;
  }

  const recent = recentSampleVerdicts(input.db, DRIFT_WINDOW);
  const gaps = recent.filter((verdict) => verdict === 'gap').length;
  const drifting = driftDetected(recent);
  if (drifting && watermark.driftGaps === null) {
    recordAlertRow(
      input.db,
      alertOf(input, `местный судья дрейфует: два расхождения среди последних ${String(recent.length)} образцов — нужен разбор`, null),
    );
    flagged = true;
  }
  // The crossing is remembered, not the count: a third gap inside the same window is the same
  // drift, and a window that clears lets the next crossing raise a fresh alert.
  watermark.driftGaps = drifting ? gaps : null;
  writeWatermark(input.db, watermark);

  input.log(`[writer] аудит образцов: прочитано ${String(drained)} из ${String(queue.length)}, ошибок ${String(errors)}`);
  if (drained === 0) return 2;
  return flagged ? 1 : 0;
}
