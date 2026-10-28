/**
 * One Tier-1 measurement (BOOK-173, BOOK-DOC-80): what the local judge costs, and whether its
 * prefix is cacheable.
 *
 * The judge is built exactly as the lane builds it — `buildTier1Prompt` over the real chapter, the
 * changed span ± two sentences (`contextOf`), and the fact sheet the plan's own quotes produce
 * (`factSheet`) — against a scratch `:memory:` ledger backfilled from `manuscript/`. Nothing is
 * written anywhere: the target is an artifact the A/B run already produced (`ab-B-ch01.json`), read
 * as the change the judge would see.
 *
 * Two calls, the same messages, because the second one is the measurement that matters: the design
 * claims Tier 1 is cheap partly because the judge shares the writer's cache prefix byte for byte.
 * The first call shows the cold price; the second, the hit.
 *
 * The budget is the owner's: **$0.02 peak for the whole measurement**, on top of the run's sticky
 * cap. The projection is the input at this book's measured ratio (3.0 characters per token — the
 * cache round measured 13 879 chars → 4 572 tokens) plus the verdict's realistic output (400
 * tokens: the module's own cap is 2 000, and «two findings and two words» fit in a fraction of it).
 * Before every call the rule is the same: if the spend so far plus this projection would cross
 * $0.02, the call is not made and the report says which row is missing.
 */

import { readChapter } from '../../server/src/engine/text.ts';
import { TIER1_MAX_TOKENS, buildTier1Prompt, factSheet, parseTier1Answer, tier1Messages, contextOf, type Tier1Parse } from '../../server/src/writer/verify/tier1.ts';
import { changedRegion, touchedBlocks } from '../../server/src/writer/verify/region.ts';
import { costOf, SpendCapError, type Rates } from './metrics.ts';
import { planFor, type Ledger } from './ledger.ts';
import { loadArtifact, saveArtifact } from './store.ts';
import { filingOf, CACHE_WARM_WAIT_MS } from './spec.ts';
import type { Priced, CallModel } from './modes.ts';

/** The owner's allowance for this one measurement, peak basis. */
export const TIER1_BUDGET_USD = 0.02;
/** The verdict's realistic output, tokens: what a two-line answer and two findings cost. */
const TIER1_OUT_TOKENS = 400;
/** This book's measured ratio (`13 879 chars → 4 572 tokens`) — the input is not under-stated. */
const CHARS_PER_TOKEN = 3;

export type Tier1Row = {
  call: number;
  in: number | null;
  out: number | null;
  cachedIn: number | null;
  usdBook: number | null;
  usdPeak: number | null;
  wallMs: number | null;
  finishReason: string | null;
  verdict: string | null;
  findings: number;
  detail: string | null;
  refusal: string | null;
};

export type Tier1Measurement = {
  rows: Tier1Row[];
  missing: string | null;
  spent: { usdBook: number; usdPeak: number };
  prompt: { systemChars: number; userChars: number; estPrefixTokens: number; estTailTokens: number; facts: number; spanChars: number; prefixSha256: string };
};

function projectionUsd(chars: number, rates: Rates): number {
  return costOf({ in: Math.ceil(chars / CHARS_PER_TOKEN), out: TIER1_OUT_TOKENS, cachedIn: 0 }, rates, 2);
}

function rowOf(call: number, result: Priced, parse: Tier1Parse): Tier1Row {
  return {
    call,
    in: result.usage.promptTokens,
    out: result.usage.completionTokens,
    cachedIn: result.usage.cacheHit,
    usdBook: result.cost.usdBook,
    usdPeak: result.cost.usdPeak,
    wallMs: result.latencyMs,
    finishReason: result.finishReason,
    verdict: parse.ok ? parse.verdict : 'TIER1_UNPARSED',
    findings: parse.ok && parse.verdict === 'GAP' ? parse.findings.length : 0,
    detail: parse.ok ? null : parse.reason,
    refusal: null,
  };
}

export async function runTier1(input: {
  bookRoot: string;
  rates: Rates;
  call: CallModel;
  ledger: Ledger;
  pin: { model: string; apiModel: string; endpoint: string };
}): Promise<Tier1Measurement> {
  const artifact = loadArtifact('ab-B-ch01.json');
  const applied = (() => {
    const landed = artifact?.landed as { text?: unknown } | undefined;
    return typeof landed?.text === 'string' ? landed.text : null;
  })();
  if (applied === null) throw new Error('tier1: ab-B-ch01.json has no landed text — run `ab` first');

  const chapter = 1;
  const filing = filingOf('ch01');
  const before = readChapter(input.bookRoot, chapter).text;
  const built = planFor({ db: input.ledger.db, filing, before, after: applied });
  const region = changedRegion(before, applied);
  const span = contextOf(applied, region);
  const touched = touchedBlocks(before, applied, chapter);
  const facts = factSheet(built.plan, touched.after);
  const prompt = buildTier1Prompt({ bookRoot: input.bookRoot, chapter, span: span.text, facts });
  const messages = tier1Messages(prompt);
  const projection = projectionUsd(prompt.chars, input.rates);

  const result: Tier1Measurement = {
    rows: [],
    missing: null,
    spent: { usdBook: 0, usdPeak: 0 },
    prompt: {
      systemChars: prompt.system.length,
      userChars: prompt.user.length,
      estPrefixTokens: Math.ceil(prompt.system.length / CHARS_PER_TOKEN),
      estTailTokens: Math.ceil(prompt.user.length / CHARS_PER_TOKEN),
      facts: prompt.facts,
      spanChars: span.text.length,
      prefixSha256: prompt.prefixSha256,
    },
  };

  for (const call of [1, 2] as const) {
    if (result.spent.usdPeak + projection > TIER1_BUDGET_USD) {
      result.missing = `call ${String(call)} not made: $${result.spent.usdPeak.toFixed(4)} spent + $${projection.toFixed(
        4,
      )} projected would cross the $${TIER1_BUDGET_USD.toFixed(2)} allowance`;
      break;
    }
    if (call === 2) await new Promise((resolve) => setTimeout(resolve, CACHE_WARM_WAIT_MS));
    let priced: Priced;
    try {
      priced = await input.call(messages, TIER1_MAX_TOKENS, `tier1 ch01 #${String(call)}`);
    } catch (error) {
      if (error instanceof SpendCapError) throw error;
      result.rows.push({
        call,
        in: null,
        out: null,
        cachedIn: null,
        usdBook: null,
        usdPeak: null,
        wallMs: null,
        finishReason: null,
        verdict: null,
        findings: 0,
        detail: null,
        refusal: (error as { code?: string }).code ?? 'CALL_FAILED',
      });
      result.missing = `call ${String(call)} refused by the provider`;
      break;
    }
    const parse = parseTier1Answer(priced.text);
    result.rows.push(rowOf(call, priced, parse));
    result.spent = {
      usdBook: result.spent.usdBook + priced.cost.usdBook,
      usdPeak: result.spent.usdPeak + priced.cost.usdPeak,
    };
  }

  saveArtifact('tier1-ch01.json', {
    command: 'tier1',
    id: 'ch01',
    run: { chapter, filing: filing.label, source: 'ab-B-ch01.json', maxTokens: TIER1_MAX_TOKENS },
    request: {
      model: input.pin.model,
      apiModel: input.pin.apiModel,
      maxTokens: TIER1_MAX_TOKENS,
      systemChars: prompt.system.length,
      userChars: prompt.user.length,
      prefixSha256: prompt.prefixSha256,
      facts: prompt.facts,
      spanChars: span.text.length,
      region: { start: region.start, end: region.end },
      span: { from: span.from, to: span.to },
      touchedBlocks: touched.after.length,
      projectionUsd: Math.round(projection * 1_000_000) / 1_000_000,
      budgetUsd: TIER1_BUDGET_USD,
    },
    prompt: { system: prompt.system, user: prompt.user },
    rows: result.rows,
    spent: {
      usdBook: Math.round(result.spent.usdBook * 1_000_000) / 1_000_000,
      usdPeak: Math.round(result.spent.usdPeak * 1_000_000) / 1_000_000,
    },
    missing: result.missing,
  });
  return result;
}
