/**
 * The answer parser (ADR-038 §8, BOOK-DOC-42 §2): a verdict for **this** item, or an error.
 *
 * Three shapes are accepted, each bound to the gate that asked:
 *
 *   * `book.verdict/v1` JSON — the canonical answer: it names its item, its gate, its verdict
 *     and the evidence it rests on. The binding is checked first (a verdict for another item
 *     is malformed, never a default), then the enum, then the evidence post-check: each quote is
 *     normalised (NFKC, controls and invisibles removed, whitespace collapsed, trimmed,
 *     case-folded) and must be ≥12 characters **and** a substring of the field it names.
 *   * the plain gate form: the first `FITS|OFF` token (gate C) or `PASS|HELD` (gate A) or
 *     `CLEAR|REFUSED` (gate B), the rest the reason.
 *   * the plain role form: the first `HOLDS|GAP` token, then finding lines that start with
 *     `blocker`, `major` or `minor`.
 *
 * Anything else is `VERDICT_MALFORMED`. A parser that guesses would turn a broken envelope into
 * a recorded judgement, which is the one thing this lane exists to prevent.
 */

import { GATE_VERDICTS } from './corpus.mjs';
import { fieldOf } from './envelope.mjs';

export const VERDICT_VERSION = 'book.verdict/v1';
const MIN_QUOTE = 12;
/** A rule id: `INJ-ENC`, `RIGHTS-QUOTE`, … — the closed table lives in BOOK-DOC-42, not here. */
const RULE_ID = /^[A-Z][A-Z0-9-]*$/u;

/** NFKC, controls and invisibles out, whitespace collapsed, trimmed, case-folded. */
export function normalize(text) {
  return String(text)
    .normalize('NFKC')
    // C0/C1, format characters (zero-width, bidi), variation selectors: not content.
    .replace(/[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

function malformed(reason) {
  return { ok: false, error: 'VERDICT_MALFORMED', reason };
}

/** Without an envelope the only cit-able field is the row's own text (unit rows, plumbing). */
function rowField(row, field) {
  const name = String(field ?? '').toLowerCase();
  if (['input', 'text', 'intent', 'comment', 'body'].includes(name)) return row.input;
  return null;
}

/** Strip one wrapping fence (` ``` ` or ` ```json `) so a fenced answer is still an answer. */
export function unfence(text) {
  const trimmed = text.trim();
  const match = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/u.exec(trimmed);
  return match === null ? { text: trimmed, unfenced: false } : { text: match[1].trim(), unfenced: true };
}

function asVerdictObject(text) {
  const candidate = unfence(text).text;
  if (!candidate.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(candidate);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function markedVersion(object) {
  // `envelope` is the canonical marker (BOOK-DOC-42 §2); the others are tolerated so a session
  // that writes `version`/`schema` still parses, but never with a default verdict.
  for (const key of ['envelope', 'version', 'schema', 'format']) {
    if (object[key] === VERDICT_VERSION) return true;
  }
  return false;
}

/** `book.verdict/v1` — item bound, gate bound, enum bound, evidence post-checked. */
function parseVersioned(object, row, envelope) {
  if (!markedVersion(object)) return malformed('the JSON answer is not a book.verdict/v1 object');
  if (typeof object.itemId !== 'string' || object.itemId.trim().length === 0) {
    return malformed('the answer carries no itemId');
  }
  if (envelope !== null && object.itemId !== envelope.itemId) {
    return malformed(`the answer is bound to ${object.itemId}, not to this item`);
  }
  if (String(object.gate ?? '').toUpperCase() !== row.gate) {
    return malformed(`the answer names gate ${String(object.gate)} for a gate ${row.gate} row`);
  }
  const verdict = String(object.verdict ?? '').toUpperCase();
  if (!GATE_VERDICTS[row.gate].includes(verdict)) {
    return malformed(`"${verdict}" is not a ${row.gate} verdict`);
  }
  const rule = object.rule ?? null;
  if (rule !== null && (typeof rule !== 'string' || !RULE_ID.test(rule))) {
    return malformed(`"${String(rule)}" is not a rule id`);
  }
  const evidence = object.evidence;
  if (evidence !== undefined) {
    if (!Array.isArray(evidence)) return malformed('evidence must be a list');
    for (const item of evidence) {
      const quote = item?.quote;
      if (typeof quote !== 'string') return malformed('an evidence item has no quote');
      const value = envelope === null ? rowField(row, item.field) : fieldOf(envelope, item.field);
      if (value === null) return malformed(`evidence cites an unknown field "${String(item.field)}"`);
      const normalizedQuote = normalize(quote);
      if (normalizedQuote.length < MIN_QUOTE) return malformed('an evidence quote is shorter than 12 characters');
      if (!normalize(value).includes(normalizedQuote)) {
        return malformed('an evidence quote is not a substring of the field it names');
      }
    }
  }
  return {
    ok: true,
    format: VERDICT_VERSION,
    verdict,
    rule,
    reason: typeof object.reason === 'string' ? object.reason : null,
    findings: [],
  };
}

const FINDING_LINE = /^(blocker|major|minor)\b[:\s-]*(.*)$/iu;

/** The plain form: a verdict token, then finding lines for the two gates that take findings. */
function parsePlain(text, row) {
  const body = unfence(text).text;
  if (row.gate === 'C') {
    const match = /\b(FITS|OFF)\b/iu.exec(body);
    if (match === null) return malformed('no FITS|OFF token in the answer');
    return {
      ok: true,
      format: 'plain',
      verdict: match[1].toUpperCase(),
      rule: null,
      reason: body.slice(match.index + match[0].length).trim(),
      findings: [],
    };
  }
  if (row.gate === 'B') {
    const match = /\b(CLEAR|REFUSED)\b/u.exec(body);
    if (match === null) return malformed('no CLEAR|REFUSED token in the answer');
    return { ok: true, format: 'plain', verdict: match[1], rule: null, reason: null, findings: [] };
  }
  // Gate A is `PASS|HELD`.
  const match = /\b(PASS|HELD)\b/u.exec(body);
  if (match === null) return malformed('no PASS|HELD token in the answer');
  return { ok: true, format: 'plain', verdict: match[1], rule: null, reason: null, findings: [] };
}

/**
 * A gate row: `book.verdict/v1` if it is one (bound to `envelope.itemId`), otherwise the gate's
 * plain form. `envelope` is optional only for unit rows; a live run always passes one.
 */
export function parseGateAnswer(text, row, envelope = null) {
  const object = asVerdictObject(text);
  return object === null ? parsePlain(text, row) : parseVersioned(object, row, envelope);
}

/**
 * A role answer (writer/editor/consultant, §8): the first `HOLDS|GAP` token, then one finding
 * per line that starts with a severity. A `GAP` without a blocker line is passed as it is —
 * the engine downgrades it, which is a recorded fact, not a lane failure.
 */
export function parseRoleAnswer(text, role) {
  const body = unfence(text).text;
  const match = /\b(HOLDS|GAP)\b/u.exec(body);
  if (match === null) return malformed(`no HOLDS|GAP token in the ${role} answer`);
  const findings = [];
  for (const line of body.split('\n')) {
    const found = FINDING_LINE.exec(line.trim());
    if (found === null) continue;
    findings.push({
      severity: found[1].toLowerCase(),
      location: '',
      defect: found[2].trim().slice(0, 1_000),
      fix: '',
    });
  }
  return {
    ok: true,
    format: 'plain',
    verdict: match[1],
    findings,
    reason: body.slice(match.index + match[0].length).trim(),
  };
}
