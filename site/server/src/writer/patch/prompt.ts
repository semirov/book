/**
 * The patch prompt (BOOK-173 §5): the same cache-first order as the writer's, with a different
 * answer protocol and a different context.
 *
 * Patch mode does **not** send the neighbours' chapter text. Its context is the chapter itself —
 * printed block by block, each with its content-derived id — plus the place, the frame and the
 * assignment: a patch names blocks of *this* chapter, and a neighbour's prose would be read as
 * context the model cannot use (and paid for on every call). Rewrite mode keeps the neighbours,
 * because there the model writes the whole chapter and continuity is the job.
 *
 * The prefix is canon → §1 → the patch protocol; the tail ends on one reminder line. Guarded by
 * `parsePatchAnswer` on the way back and by `applyPatch` after that: this file only asks.
 */

import { parseChapter } from '../../ingest/parseChapter.ts';
import { sha256Hex } from '../../util/hash.ts';
import { isWrittenChapter, readChapter } from '../../engine/text.ts';
import { PromptError, assignmentSection, canonParts, frameSection, placeSection, roleSection, type PromptPart, type PromptSection, type WriterAssignmentData } from '../prompt.ts';
import { PATCH_MAX_EDITS, PATCH_MAX_FACTS, PATCH_MAX_FACT_CHARS, PATCH_MAX_NEW_CHARS, PATCH_MAX_NOTE_CHARS, PATCH_MAX_OLD_CHARS } from './protocol.ts';

export type PatchPrompt = {
  system: string;
  user: string;
  prefixSha256: string;
  promptSha256: string;
  sections: Array<{ id: string; chars: number; sha256: string }>;
  blocks: Array<{ id: string; text: string }>;
};

export type PatchPromptInput = { bookRoot: string; chapter: number; assignment: WriterAssignmentData };

function part(id: string, body: string): PromptPart {
  return { section: { id, chars: body.length, sha256: sha256Hex(body) }, body };
}

/** The answer protocol: the JSON shape and every bound the parser and the applier enforce. */
function protocolSection(): PromptPart {
  const body = [
    '## Что вернуть',
    'Верни ровно один JSON-объект и больше ничего: ни текста до него, ни текста после.',
    '```json',
    '{"mode":"patch","edits":[{"blockId":"ch40#a1b2c3d4","oldText":"дословные байты","newText":"что встаёт на их место"}],"facts":[],"note":null}',
    '```',
    `- \`mode\`: "patch" — правка. "rewrite" — правка невозможна (например, меняется число или затронута вся глава): тогда edits пуст, а причина — в note; проход перепишет главу целиком.`,
    `- \`edits\`: от 1 до ${String(PATCH_MAX_EDITS)}; одна правка — один абзац; нулевая правка не принимается.`,
    '- `blockId`: id абзаца ровно как напечатан ниже; `null` — вставка нового абзаца, тогда обязателен `afterBlockId` с id абзаца, после которого он встаёт, и `oldText` пуст.',
    `- \`oldText\`: дословная копия байтов из названного абзаца (не более ${String(PATCH_MAX_OLD_CHARS)} знаков), ровно одно вхождение в нём; цитата никогда не переходит через границу абзаца.`,
    `- \`newText\`: что встаёт на место скопированного (не более ${String(PATCH_MAX_NEW_CHARS)} знаков); "" удаляет абзац целиком; без пустой строки внутри и без «#» в начале.`,
    `- \`facts\`: от 0 до ${String(PATCH_MAX_FACTS)} строк (каждая не длиннее ${String(PATCH_MAX_FACT_CHARS)} знаков) — то, что правка утверждает или не должна сломать, дословно так, как это будет читаться в главе.`,
    `- \`note\`: одна строка по-английски, не длиннее ${String(PATCH_MAX_NOTE_CHARS)} знаков — только для журнала; в главу она не попадает.`,
    '',
    'Числа и аббревиатуры в заменяемом месте должны остаться в главе; если нужно поменять число — верни "rewrite" и объясни в note.',
  ].join('\n');
  return part('protocol', body);
}

/** Every block of the chapter, printed with its id, in order: the only pre-image a patch may name. */
function blocksSection(blocks: ReadonlyArray<{ id: string; text: string }>): PromptPart {
  const lines = ['## Абзацы этой главы, с id', 'Это единственный текст, который можно править; id — адрес правки, текст под ним — дословно.'];
  for (const block of blocks) lines.push('', `### ${block.id}`, block.text);
  return part('chapter', lines.join('\n'));
}

function reminderSection(): PromptPart {
  return part(
    'reminder',
    ['## Напоминание', 'Ответ — ровно один JSON-объект формы выше: mode, edits, facts, note. Ни прозы, ни markdown вокруг.'].join('\n'),
  );
}

/**
 * Build the patch prompt for one chapter. Refuses a chapter with no prose: a patch needs a
 * pre-image, and a basis-only slot is the frozen frame.
 */
export function buildPatchPrompt(input: PatchPromptInput): PatchPrompt {
  const own = readChapter(input.bookRoot, input.chapter);
  if (!isWrittenChapter(own)) {
    throw new PromptError('PROMPT_INPUT_INVALID', `chapter ${String(input.chapter)} has no prose to patch`);
  }
  const blocks = parseChapter(input.chapter, own.raw).blocks.map((block) => ({ id: block.id, text: block.text }));
  const prefix: PromptPart[] = [...canonParts(input.bookRoot), roleSection(input.bookRoot), protocolSection()];
  const tail: PromptPart[] = [
    placeSection(input.chapter),
    frameSection(input.chapter),
    blocksSection(blocks),
    assignmentSection(input.assignment),
    reminderSection(),
  ];
  const system = prefix.map((entry) => entry.body).join('\n\n');
  const user = tail.map((entry) => entry.body).join('\n\n');
  const sections: PromptSection[] = [...prefix, ...tail].map((entry) => entry.section);
  return {
    system,
    user,
    prefixSha256: sha256Hex(system),
    promptSha256: sha256Hex(`${system}\n\n${user}`),
    sections,
    blocks,
  };
}
