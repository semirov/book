import { describe, expect, it } from 'vitest';

import { checkPromptNames, promptGuardNames } from '../../src/validate/prompts.ts';

const DOSSIERS = `# Досье персонажей

Персонажи заранее не задаются.

## Половик
Сторож по прозвищу Ерофей, ночная смена, ничего не решает.
`;

describe('F024 — no names in prompts (§6E.2)', () => {
  it('takes the recorded names from the dossiers file and the chapter titles', () => {
    const names = promptGuardNames(DOSSIERS, ['Половик в тамбуре', '', 'Глава 2']);
    expect(names).toContain('Ерофей');
    expect(names).toContain('Половик в тамбуре');
    // A short or empty title line is not a name.
    expect(names).not.toContain('');
    expect(names).not.toContain('Глава 2');
  });

  it('reports a template that carries a name or a title line', () => {
    const names = promptGuardNames(DOSSIERS, ['Половик в тамбуре']);
    const findings = checkPromptNames(
      [
        {
          file: 'process/WRITE_FWD_TEMPLATE.md',
          text: 'Ты пишешь главу рядом с Ерофей и не меняешь «Половик в тамбуре».',
        },
      ],
      names,
    );
    // Three: «Ерофей», the dossier heading «Половик» and the title line «Половик в тамбуре».
    expect(findings.every((finding) => finding.rule === 'F024')).toBe(true);
    expect(findings.every((finding) => finding.severity === 'error')).toBe(true);
    const messages = findings.map((finding) => finding.message).join('\n');
    expect(messages).toContain('«Ерофей»');
    expect(messages).toContain('«Половик в тамбуре»');
    expect(findings.every((finding) => finding.file === 'process/WRITE_FWD_TEMPLATE.md')).toBe(true);
  });

  it('stays quiet on a template that only describes the job', () => {
    const names = promptGuardNames(DOSSIERS, ['Половик в тамбуре']);
    const findings = checkPromptNames(
      [{ file: 'process/RUN_TEMPLATE.md', text: 'Прочитай главу, соседей и правила. Не придумывай имён.' }],
      names,
    );
    expect(findings).toEqual([]);
  });

  it('is vacuous while no person is on the page — which is the launch state', () => {
    const names = promptGuardNames('# Досье\n\n(пока пусто — чистый лист)\n', []);
    expect(checkPromptNames([{ file: 'process/RUN_TEMPLATE.md', text: 'любой текст' }], names)).toEqual([]);
  });
});
