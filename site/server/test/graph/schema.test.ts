/**
 * The answer's shape (BOOK-185, BOOK-DOC-77 §2).
 *
 * The seam between the model's text and the validator: a fenced answer is accepted, an extra key
 * is not, and a failure names the path and the rule — never the answer, because an error message
 * is printed and a chapter is not.
 */

import { describe, expect, it } from 'vitest';

import { parseAnswer } from '../../src/graph/schema.ts';

/** The example of BOOK-DOC-77 §2, verbatim: the contract the prompt shows the model. */
const DOC_EXAMPLE = `{
  "facts": [
    { "ref": "f1", "kind": "document", "value": "65/11877/арх",
      "term": "65/11877/арх", "quote": "Номер 65/11877/арх",
      "sentence": "— Номер 65/11877/арх." }
  ],
  "uses": [
    { "kind": "document", "value": "65/11877/арх",
      "quote": "дело № 65/11877/арх", "sentence": "…" }
  ],
  "edges": [
    { "from": "f1", "to": { "key": "document:65-11877-арх" },
      "kind": "document", "quote": "…", "statement": "…" }
  ],
  "threads": [
    { "label": "дело 65/11877/арх", "direction": "forward",
      "events": [ { "chapter": 5, "kind": "opened", "fact": "f1", "note": "…" } ] }
  ]
}`;

describe('parseAnswer', () => {
  it('reads the documented example', () => {
    const result = parseAnswer(DOC_EXAMPLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answer.facts[0]?.kind).toBe('document');
    expect(result.answer.edges[0]?.to).toEqual({ key: 'document:65-11877-арх' });
    expect(result.answer.threads[0]?.events[0]?.kind).toBe('opened');
  });

  it('strips a markdown fence and prose around the object', () => {
    const text = `Вот ответ:\n\`\`\`json\n${DOC_EXAMPLE}\n\`\`\`\nГотово.`;
    const result = parseAnswer(text);
    expect(result.ok).toBe(true);
  });

  it('reads a missing key as the silence it is', () => {
    const result = parseAnswer('{"facts":[]}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answer).toEqual({ facts: [], uses: [], edges: [], threads: [] });
  });

  it('refuses an extra key with the path and no answer text', () => {
    const result = parseAnswer(`{"facts":[],"notes":"${'длинная цитата'.repeat(20)}"}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('SCHEMA_INVALID');
    expect(result.error).toContain('notes');
    expect(result.error).not.toContain('длинная цитата');
  });

  it('refuses an unknown kind by path', () => {
    const result = parseAnswer('{"facts":[{"kind":"map","value":"x","quote":"y"}]}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('facts.0.kind');
    expect(result.json).toBeDefined();
  });

  it('refuses text with no object at all', () => {
    const result = parseAnswer('Ничего не нашёл.');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('SCHEMA_INVALID');
    expect(result.error).toContain('no JSON object');
  });

  it('refuses a broken object without echoing it', () => {
    const result = parseAnswer('{"facts": [ , "quote": "секрет" }');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('SCHEMA_INVALID');
    expect(result.error).not.toContain('секрет');
  });
});
