/**
 * The gates' prompts and the verdict parser (`docs/writer-lane.md` §1).
 *
 * The parser is the dangerous half: the engine downgrades a `GAP` without a blocker to `HOLDS`
 * (a prose finding), so an answer the parser could not read must be a refusal, never an empty
 * finding list. A gate that answers nothing has not said the text holds.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { buildGatePrompt, parseGateAnswer } from '../../src/writer/gates.ts';
import { PromptError, rolePromptOf } from '../../src/writer/prompt.ts';

const dirs: string[] = [];

const ROLE_PROMPTS = [
  '# Role prompts',
  '',
  '## 1. WRITER',
  '',
  '```text',
  '# WRITER',
  '```',
  '',
  '## 2. EDITOR',
  '',
  '```text',
  '# EDITOR — integrity gate',
  'Return HOLDS or GAP.',
  '```',
  '',
  '## 3. SCIENCE CONSULTANT',
  '',
  '```text',
  '# SCIENCE CONSULTANT — hard-SF soundness',
  'Return HOLDS or GAP.',
  '```',
  '',
].join('\n');

function book(): string {
  const root = mkdtempSync(join(tmpdir(), 'book-gates-'));
  dirs.push(root);
  for (const file of ['concept', 'style', 'outline', 'process']) mkdirSync(join(root, file), { recursive: true });
  writeFileSync(join(root, 'process', 'ROLE_PROMPTS.md'), ROLE_PROMPTS);
  writeFileSync(join(root, 'concept', 'CONCEPT.md'), 'канон концепции');
  writeFileSync(join(root, 'concept', 'CLIMAX.md'), 'канон финала');
  writeFileSync(join(root, 'style', 'VOICE.md'), 'канон голоса');
  writeFileSync(join(root, 'outline', 'PLAN.md'), 'канон плана');
  mkdirSync(join(root, 'manuscript'), { recursive: true });
  writeFileSync(join(root, 'manuscript', 'ch08.md'), 'Глава восемь\n\nНаписанный сосед.\n');
  writeFileSync(join(root, 'manuscript', 'ch09.md'), 'Глава девять\n\nПросмотренный текст главы.\n');
  return root;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('rolePromptOf', () => {
  it('reads each section by its own fence rule', () => {
    expect(rolePromptOf(ROLE_PROMPTS, '2')).toContain('# EDITOR');
    expect(rolePromptOf(ROLE_PROMPTS, '3')).toContain('# SCIENCE CONSULTANT');
    expect(rolePromptOf(ROLE_PROMPTS, '1')).toBe('# WRITER');
  });

  it('refuses a missing section instead of an empty system message', () => {
    try {
      rolePromptOf(ROLE_PROMPTS, '4');
    } catch (error) {
      expect(error).toBeInstanceOf(PromptError);
      expect((error as PromptError).code).toBe('PROMPT_SECTION_MISSING');
      return;
    }
    throw new Error('rolePromptOf accepted a missing section');
  });
});

describe('parseGateAnswer', () => {
  it('reads HOLDS with no findings', () => {
    expect(parseGateAnswer('HOLDS', 'editor')).toEqual({ ok: true, verdict: 'HOLDS', findings: [] });
    expect(parseGateAnswer('  holds  \n\n', 'consultant')).toEqual({ ok: true, verdict: 'HOLDS', findings: [] });
  });

  it('reads a GAP with one finding per line', () => {
    const parsed = parseGateAnswer(
      'GAP\nblocker · глава 9, «просмотренный текст» · повтор вместо прозы · переписать абзац',
      'editor',
    );
    expect(parsed).toEqual({
      ok: true,
      verdict: 'GAP',
      findings: [
        {
          severity: 'blocker',
          location: 'глава 9, «просмотренный текст»',
          defect: 'повтор вместо прозы',
          fix: 'переписать абзац',
        },
      ],
    });
  });

  it('tolerates markdown decoration around the verdict and keeps a retroactive mode', () => {
    const parsed = parseGateAnswer(
      '**GAP**\nmajor · глава 9, «текст» · документ появился после сцены · оформить · расхождение',
      'editor',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.verdict).toBe('GAP');
    expect(parsed.findings[0]).toMatchObject({ severity: 'major', mode: 'расхождение' });
  });

  it('reads the mode from inside the defect too', () => {
    const parsed = parseGateAnswer('GAP\nminor · глава 9 · нужна поправка в прошлом · оставить', 'editor');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.findings[0]?.mode).toBe('поправка');
  });

  it('refuses a GAP with no finding line — it never becomes a silent HOLDS', () => {
    const parsed = parseGateAnswer('GAP\n', 'consultant');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe('GATE_UNPARSED');
    expect(parsed.reason).toContain('GAP without');
  });

  it('refuses an answer whose first token is not a verdict', () => {
    for (const raw of ['', 'СОГЛАСЕН', 'ok, the text holds', 'HOLDS!!! no', 'GAP и всё']) {
      const parsed = parseGateAnswer(raw, 'editor');
      expect(parsed.ok, raw).toBe(false);
    }
    // HOLDS followed by punctuation is still HOLDS: the token is the whole of the first line.
    expect(parseGateAnswer('HOLDS.', 'editor')).toEqual({ ok: true, verdict: 'HOLDS', findings: [] });
  });

  it('reads three fields, leaving the fix empty, but not two', () => {
    const parsed = parseGateAnswer('GAP\nblocker · глава 9 · дефект без правки', 'editor');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.findings[0]).toMatchObject({ severity: 'blocker', fix: '' });
  });

  it('refuses a finding row that is not «severity · location · defect · fix»', () => {
    for (const raw of ['GAP\nглава 9 · что-то не так', 'GAP\nблокер · глава 9', 'GAP\nmajor · · дефект · фикс']) {
      const parsed = parseGateAnswer(raw, 'editor');
      expect(parsed.ok, raw).toBe(false);
    }
  });
});

describe('buildGatePrompt', () => {
  it('quotes §2, the canon, the landed text, the neighbours, the assignment and the contract', () => {
    const root = book();
    const prompt = buildGatePrompt({
      bookRoot: root,
      role: 'editor',
      chapter: 9,
      assignment: { chapter: 9, pass: 'change', intent: 'документ о допуске' },
      landedText: 'Глава девять\n\nПросмотренный текст главы.',
      indexSlice: '{"chapter":9,"entities":[]}',
    });

    expect(prompt.system).toContain('# EDITOR');
    expect(prompt.system).not.toContain('# SCIENCE CONSULTANT');
    expect(prompt.user).toContain('канон концепции');
    expect(prompt.user).toContain('Просмотренный текст главы.');
    expect(prompt.user).toContain('Написанный сосед.');
    expect(prompt.user).toContain('"intent": "документ о допуске"');
    expect(prompt.user).toContain('## Указатель');
    expect(prompt.user).toContain('severity · location · defect · fix');
    expect(prompt.sections.map((section) => section.id)).toEqual([
      'role',
      'canon:concept/CONCEPT.md',
      'canon:concept/CLIMAX.md',
      'canon:style/VOICE.md',
      'canon:outline/PLAN.md',
      'landed',
      'neighbours',
      'assignment',
      'index',
      'contract',
    ]);
  });

  it('gives the consultant §3 and no index slice', () => {
    const prompt = buildGatePrompt({
      bookRoot: book(),
      role: 'consultant',
      chapter: 9,
      assignment: { chapter: 9 },
      landedText: 'Глава девять\n\nПросмотренный текст главы.',
      indexSlice: '{"chapter":9}',
    });
    expect(prompt.system).toContain('# SCIENCE CONSULTANT');
    expect(prompt.user).not.toContain('## Указатель');
    expect(prompt.sections.map((section) => section.id)).not.toContain('index');
  });

  it('says so when the assignment’s intent could close its own fence', () => {
    const prompt = buildGatePrompt({
      bookRoot: book(),
      role: 'editor',
      chapter: 9,
      assignment: { intent: 'хвост ``` конец' },
      landedText: 'Глава девять\n\nТекст.',
      indexSlice: null,
    });
    expect(prompt.user).toContain('````text');
  });
});
