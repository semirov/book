/**
 * Types for `scripts/lib/position.mjs` (BOOK-209) — the pure half of the position harness,
 * imported by `server/test/positionReport.test.ts`. Only the surface the test uses is declared:
 * a synthetic row, a synthetic report, and the three answers (summary, verdict, record).
 */

export const POSITION_TARGET_PX: 16;
export const POSITION_TOLERANCE_PX: 2;

export type PositionRow = {
  /** The contents row / chapter number, 1..42. */
  row: number;
  /** The viewport width the row was measured at. */
  width: number;
  /** The edge that was measured: the heading (`.ch-h`) or an empty slot's `<article>`. */
  head: 'ch-h' | 'article' | 'missing';
  expected: number;
  actual: number | null;
  delta: number | null;
  at150: number | null;
  at800: number | null;
  stable: boolean;
  prevented?: boolean;
  scrollY?: number | null;
};

export type PositionBack = {
  /** The viewport width the case was measured at. */
  width?: number;
  case: string;
  /** How the reader left: a tap on the page's own link, or a hash the harness wrote. */
  via?: 'link' | 'hash';
  sentence: string;
  before: number | null;
  after: number | null;
  delta: number | null;
  found: boolean;
};

/** One device's measured landing: `restored` is null when the harness never measured it. */
export type PositionPlace = {
  measured: boolean;
  top: number | null;
  sentence: string | null;
  before: number | null;
  after: number | null;
  /** true — the anchor came back; false — measured and missed; null — not measured here. */
  restored: boolean | null;
  anchor?: { chapter: number; sentenceId: string; deltaPx: number; at: string } | null;
  key?: string | null;
  /** Keys in `localStorage` after the resume — the context itself started empty. */
  storageAfterResume?: number;
};

/** The server's own answer about the place route, asked anonymously and with a session. */
export type PositionServerProbe = {
  outcome: 'absent' | 'guarded' | 'answered';
  anonymous: number;
  signed: number;
};

export type PositionResume = {
  server: PositionServerProbe;
  anchor: { chapter: number; sentenceId: string; deltaPx: number; at: string } | null;
  put: number | null;
  sameDevice: PositionPlace | null;
  secondDevice: PositionPlace | null;
  pixels?: number | null;
};

export type PositionReport = {
  commit: string;
  branch: string;
  at: string;
  target: number;
  tolerance: number;
  widths: number[];
  dirty: string[];
  browser: string;
  freshPerRow?: boolean;
  rows: PositionRow[];
  back: PositionBack[];
  source?: string;
  note?: string | null;
  seed?: {
    how: 'book' | 'volume' | 'fixture';
    source: string | null;
    line: string;
    /** Counts of the fixture manuscript the run wrote, when `how` is `fixture`. */
    fixture?: { files: number; chapters: number; blocks: number; bytes: number } | null;
    /** The scratch identity the second device was signed in as — never its cookie. */
    identityId?: string | null;
  } | null;
  /** The read budget the measured server booted with (`READ_PER_MINUTE`). */
  budget?: { readPerMinute: number };
  resume: PositionResume;
};

export type PositionVerdict = { code: 0 | 1; reasons: string[] };

export function round2(value: number): number | null;
export function median(values: number[]): number | null;
export function rowHolds(row: PositionRow, tolerance?: number): boolean;
export function summariseRows(rows: PositionRow[], tolerance?: number): PositionBucket[];
export function backMisses(back: PositionBack[], tolerance?: number): PositionBack[];
export function resumeMisses(resume: PositionResume, tolerance?: number): Array<{ device: string }>;
export function positionVerdict(report: PositionReport, tolerance?: number): PositionVerdict;
export function markdownReport(report: PositionReport, options?: { stage?: string }): string;
