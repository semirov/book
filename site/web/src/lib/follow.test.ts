import type { CascadeWingsDto, ChangeDecidedPayload } from '@book/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  currentFollow,
  currentNotice,
  decidedWord,
  dismissNotice,
  follow as recordFollow,
  followDirection,
  followLabel,
  isFollowing,
  landFollowed,
  unfollow,
  type FollowDirection,
} from './follow.ts';

/**
 * BOOK-207 — the follow control's words and its one store.
 *
 * The direction words are the owner's: `up` is «вперёд», `down` is «назад» (the ribbon keeps
 * its own «вниз/вверх»). The number is a fact about what a wing reached, the label freezes on
 * the tap, and the five landing words are a closed set.
 */

function wings(over: Partial<CascadeWingsDto> = {}): CascadeWingsDto {
  return {
    down: { frontier: 8, wave: 1, state: 'moving', reached: [8, 7] },
    up: { frontier: 20, wave: 2, state: 'moving', reached: [20, 21] },
    ...over,
  };
}

function decided(over: Partial<ChangeDecidedPayload> = {}): ChangeDecidedPayload {
  return {
    id: 'chg_7',
    commentId: 'cmt_1',
    outcome: 'applied',
    reason: null,
    chapters: [12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
    cascade: null,
    relevance: null,
    tokens: { total: 0 },
    decidedAt: '2026-10-29T09:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  unfollow('chg_7');
  dismissNotice();
});

describe('the direction is the wings’ own fact', () => {
  it('prints «вперёд» and «назад», with the furthest and the nearest reached chapter', () => {
    const direction = followDirection('chg_7', wings());
    expect(direction).toEqual({
      changeId: 'chg_7',
      dirs: [
        { side: 'up', to: 21, wave: 2 },
        { side: 'down', to: 7, wave: 1 },
      ],
    });
    expect(followLabel(direction, null)).toBe('следить · вперёд · до главы 21 · назад · до главы 7');
  });

  it('prints a direction without a number when the wing reached nothing yet', () => {
    const direction = followDirection('chg_7', {
      up: { frontier: 14, wave: 1, state: 'moving', reached: [] },
      down: { frontier: 14, wave: 0, state: 'waiting', reached: [] },
    });
    expect(followLabel(direction, null)).toBe('следить · вперёд');
  });

  it('has no control when no wing is moving', () => {
    expect(followDirection('chg_7', null)).toBeNull();
    expect(
      followDirection('chg_7', {
        up: { frontier: 14, wave: 1, state: 'stopped', reached: [15] },
        down: { frontier: 14, wave: 0, state: 'settled', reached: [13] },
      }),
    ).toBeNull();
    expect(followLabel(null, null)).toBeNull();
  });

  it('reads one moving wing on its own side', () => {
    const direction = followDirection('chg_7', {
      up: { frontier: 21, wave: 1, state: 'moving', reached: [21] },
      down: { frontier: 14, wave: 0, state: 'waiting', reached: [] },
    });
    expect(followLabel(direction, null)).toBe('следить · вперёд · до главы 21');
  });
});

describe('the freeze', () => {
  it('keeps the words recorded at the tap when the ribbon later reverses', () => {
    const before = followDirection('chg_7', wings())!;
    const held = recordFollow(before, 1_000);
    expect(held.dirs.map((dir) => dir.to)).toEqual([21, 7]);
    const reversed = followDirection('chg_7', {
      up: { frontier: 14, wave: 3, state: 'moving', reached: [15] },
      down: { frontier: 14, wave: 0, state: 'waiting', reached: [] },
    });
    // The unfollowed form would move; the followed form reads the store only.
    expect(followLabel(reversed, null)).toBe('следить · вперёд · до главы 15');
    expect(followLabel(reversed, currentFollow('chg_7'))).toBe(
      'слежу · вперёд · до главы 21 · назад · до главы 7',
    );
  });

  it('drops the follow only on the second tap', () => {
    const direction: FollowDirection = followDirection('chg_7', wings())!;
    recordFollow(direction, 1_000);
    expect(isFollowing('chg_7')).toBe(true);
    unfollow('chg_7');
    expect(isFollowing('chg_7')).toBe(false);
    expect(followLabel(direction, null)).toBe('следить · вперёд · до главы 21 · назад · до главы 7');
  });
});

describe('the five landing words', () => {
  it('is a closed set, and every outcome has one', () => {
    expect(decidedWord('applied')).toBe('правка внесена');
    expect(decidedWord('adapted')).toBe('правка внесена частично');
    expect(decidedWord('registered')).toBe('правка рассмотрена');
    expect(decidedWord('dropped')).toBe('правка не внесена');
    expect(decidedWord('failed')).toBe('правка не внесена');
    expect(decidedWord('escalated')).toBe('правка остановлена');
    expect(decidedWord('nonsense')).toBeNull();
  });

  it('lands only a followed change, drops the follow and keeps the read chapter', () => {
    recordFollow(followDirection('chg_7', wings())!, 1_000);
    expect(landFollowed(decided({ id: 'chg_other' }), 12)).toBe(false);
    expect(currentNotice()).toBeNull();
    expect(isFollowing('chg_7')).toBe(true);

    expect(landFollowed(decided(), 12)).toBe(true);
    expect(isFollowing('chg_7')).toBe(false);
    expect(currentNotice()).toEqual({
      chapter: 12,
      word: 'правка внесена',
      chapters: [12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
    });
    // Nothing is dropped by a step: a second landing replaces the first line only.
    expect(landFollowed(decided(), 12)).toBe(false);
    dismissNotice();
    expect(currentNotice()).toBeNull();
  });

  it('has no chapter to print into when the reader is on the cover, and still ends the follow', () => {
    recordFollow(followDirection('chg_7', wings())!, 1_000);
    expect(landFollowed(decided({ outcome: 'escalated' }), null)).toBe(true);
    expect(currentNotice()).toBeNull();
    expect(isFollowing('chg_7')).toBe(false);
  });
});
