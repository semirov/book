/**
 * One Russian line per log entry (§11.10: «глава 9 переписана правкой 7 (Аня)»).
 *
 * The summary is built once, on the server, so the chronicle, a REST page and a WS frame
 * cannot describe the same fact in two ways. It never repeats a gate finding's text: a
 * verdict is summarised as «замечание сохранено» (§6F.1 rule 5, §6F.7).
 */

import type { HistoryKind } from '@book/shared';

import { AUTHOR_LABEL, OUT_OF_PROCESS_LABEL, OPERATOR_LABEL } from '../ingest/attribution.ts';

export type SummarySubject = {
  kind: HistoryKind;
  chapter: number | null;
  isFront: boolean;
  rev: number | null;
  /** The public iteration number of the change this event belongs to («правка 7»). */
  changeSeq: number | null;
  authorKind: string;
  authorLabel: string;
  payload: Record<string, unknown>;
};

function target(subject: SummarySubject): string {
  if (subject.isFront) return 'первая страница';
  return subject.chapter === null ? 'книга' : `глава ${subject.chapter}`;
}

/** «главы 9» — for a noun that owns the fact («шаг главы 9»). */
function targetGenitive(subject: SummarySubject): string {
  if (subject.isFront) return 'первой страницы';
  return subject.chapter === null ? 'книги' : `главы ${subject.chapter}`;
}

/** «главу 9» — for the one verb that needs the accusative (a restore is done *to* the text). */
function targetAccusative(subject: SummarySubject): string {
  if (subject.isFront) return 'первую страницу';
  return subject.chapter === null ? 'книгу' : `главу ${subject.chapter}`;
}

/** The public name of the change, when one is attached: «правкой 7 (Аня)». */
function byChange(subject: SummarySubject): string {
  if (subject.changeSeq === null) {
    if (subject.authorKind === 'unattributed') return ` — ${OUT_OF_PROCESS_LABEL}`;
    if (subject.authorKind === 'operator') return ` — ${OPERATOR_LABEL}`;
    return '';
  }
  const who =
    subject.authorKind === 'reader' && subject.authorLabel.length > 0 && subject.authorLabel !== AUTHOR_LABEL
      ? ` (${subject.authorLabel})`
      : '';
  return ` правкой ${subject.changeSeq}${who}`;
}

function decisionCopy(subject: SummarySubject): string {
  const outcome = typeof subject.payload.outcome === 'string' ? subject.payload.outcome : null;
  const status = typeof subject.payload.status === 'string' ? subject.payload.status : null;
  const reason = typeof subject.payload.reason === 'string' ? subject.payload.reason.replace(/\s+/gu, ' ').trim() : '';
  if (status === 'void' || outcome === 'dropped' || outcome === 'superseded') {
    const tail = reason.length > 0 ? `: ${reason.slice(0, 120)}` : '';
    return `правка ${subject.changeSeq ?? '?'} не применена${tail}`;
  }
  if (status === 'escalated' || outcome === 'origin' || outcome === 'budget' || outcome === 'oscillation') {
    return `правка ${subject.changeSeq ?? '?'} требует решения${reason.length > 0 ? `: ${reason.slice(0, 120)}` : ''}`;
  }
  if (outcome === 'adapted') return `правка ${subject.changeSeq ?? '?'} внесена в суженном виде`;
  return `правка ${subject.changeSeq ?? '?'} внесена`;
}

export function summarize(subject: SummarySubject): string {
  const where = target(subject);
  const by = byChange(subject);
  switch (subject.kind) {
    case 'chapter.created':
      return `${where} написана${by}`;
    case 'chapter.revised': {
      const kind = typeof subject.payload.kind === 'string' ? subject.payload.kind : null;
      const verb = kind === 'rewrite' ? 'переписана' : 'изменена';
      return `${where} ${verb}${by}`;
    }
    case 'chapter.restored':
      return `${where} восстановлена из прежней ревизии`;
    case 'front.revised':
      // Page 2 is basis against a pass (BOOK-DOC-6), but an owner hand edit may replace it
      // (BOOK-7). A refused rewrite still says so; an accepted annotation change is named
      // with the page, not with the title line it did not move.
      if (subject.payload.titleChanged === false && subject.payload.annotationRejected !== undefined) {
        return `страница 2 — основа: переписать не дали${by}`;
      }
      if (subject.payload.annotationChanged === true) return `${target(subject)} изменилась${by}`;
      return `название изменилось${by}`;
    case 'change.queued':
      return `правка ${subject.changeSeq ?? '?'} встала в очередь`;
    case 'change.processing':
      return `правка ${subject.changeSeq ?? '?'} в работе`;
    case 'change.stale':
      return `правка ${subject.changeSeq ?? '?'}: основа изменилась`;
    case 'change.decided':
      return decisionCopy(subject);
    case 'cascade.opened':
      return `правка ${subject.changeSeq ?? '?'} пошла волной`;
    case 'cascade.closed': {
      const outcome = typeof subject.payload.outcome === 'string' ? subject.payload.outcome : null;
      if (outcome !== null && outcome.startsWith('escalated:')) return `волна правки ${subject.changeSeq ?? '?'} остановлена`;
      return `волна правки ${subject.changeSeq ?? '?'} закончена`;
    }
    case 'step.opened':
      return `шаг ${targetGenitive(subject)} открыт${by}`;
    case 'step.landed':
      return `${where} записана${by}`;
    case 'step.closed': {
      const outcome = typeof subject.payload.outcome === 'string' ? subject.payload.outcome : null;
      const verb =
        outcome === 'rewritten' || outcome === 'published_with_finding'
          ? 'переписана'
          : outcome === 'escalated'
            ? 'остановлена'
            : outcome === 'interrupted'
              ? 'прервана'
              : 'держится';
      return `${where}: ${verb}${by}`;
    }
    case 'gate.recorded': {
      const role = subject.payload.role === 'consultant' ? 'научный консультант' : 'редактор';
      return `${where}: замечание сохранено (${role})`;
    }
    case 'overwrite': {
      const replaced = typeof subject.payload.replacedBy === 'string';
      const place = subject.chapter === null ? where : `в главе ${subject.chapter}`;
      return replaced ? `${place} абзац переписан${by}` : `${place} абзац убран${by}`;
    }
    case 'operator.restore':
      return `оператор восстановил ${targetAccusative(subject)}`;
    case 'operator.release':
      return `оператор снял аренду: ${where}`;
    case 'operator.hide':
      return `оператор скрыл ${targetAccusative(subject)}`;
    default:
      return `${where}${by}`;
  }
}
