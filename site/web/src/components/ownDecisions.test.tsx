import type { MyDecisionsDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { OwnDecisions } from './OwnDecisions.tsx';

/**
 * BOOK-13 — the durable line in the end matter. It is on the page from the server's answer,
 * so it survives a reload; it is not a toast, and it does not exist for a reader with no
 * interventions (no fake zero card).
 */

function record(overrides: Partial<MyDecisionsDto> = {}): MyDecisionsDto {
  return {
    items: [
      {
        commentId: 'cmt_A',
        changeId: 'chg_A',
        chapter: 8,
        intent: 'внести документ о регистрации сенсора',
        outcome: 'applied',
        reason: null,
        chapters: [7, 8, 9],
        waves: 3,
        blocks: 12,
        shareAtDecision: { share: 0.004, day: '2026-10-25' },
        decidedAt: '2026-10-25T12:30:00Z',
      },
    ],
    open: [],
    share: 0.004,
    ...overrides,
  };
}

describe('«ваши правки» in the end matter (BOOK-13)', () => {
  it('prints the whole summary line and the change’s own sentence', () => {
    const html = renderToStaticMarkup(<OwnDecisions decisions={record()} />);
    expect(html).toContain('правка внесена · главы 7–9 · 3 волны · изменилось 12 абзацев · ваша доля 0,4 %');
    expect(html).toContain('«внести документ о регистрации сенсора»');
    expect(html).toContain('глава 8');
    expect(html).toContain('прицел');
    expect(html).toContain('#правка-chg_A');
  });

  it('renders a refusal as its reason, with no wave, paragraph or share claim', () => {
    const refused = record({
      items: [
        {
          commentId: 'cmt_off',
          changeId: null,
          chapter: 8,
          intent: null,
          outcome: 'refused',
          reason: 'правка не про эту книгу: здесь нет утешения',
          chapters: [],
          waves: null,
          blocks: null,
          shareAtDecision: null,
          decidedAt: '2026-10-25T12:05:00Z',
        },
      ],
    });
    const html = renderToStaticMarkup(<OwnDecisions decisions={refused} />);
    expect(html).toContain('правка не принята · правка не про эту книгу: здесь нет утешения');
    expect(html).not.toContain('волн');
    expect(html).not.toContain('изменилось');
    expect(html).not.toContain('ваша доля');
    expect(html).not.toContain('прицел');
  });

  it('says nothing at all for a reader with no interventions', () => {
    expect(renderToStaticMarkup(<OwnDecisions decisions={record({ items: [], open: [] })} />)).toBe('');
    expect(renderToStaticMarkup(<OwnDecisions decisions={null} />)).toBe('');
  });
});
