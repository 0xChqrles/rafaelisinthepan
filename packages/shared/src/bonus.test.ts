// CONTRACT: the bonus puzzle's id, address and page (packages/shared/src/bonus.ts) — one
// spelling for the web routes, the backend store and round rows, the publish script.
import { describe, expect, it } from 'vitest';
import {
  BONUS_ID_MAX,
  BONUS_ID_MIN,
  bonusAddress,
  bonusPath,
  isBonusAddress,
  isBonusId,
  puzzleAddress,
} from './bonus';
import { cardPuzzleLabel } from './cardSvg';
import { dateForDayNumber } from './day';

describe('the bonus id', () => {
  it('is seven digits with no leading zero', () => {
    expect(isBonusId('1234567')).toBe(true);
    expect(isBonusId(String(BONUS_ID_MIN))).toBe(true);
    expect(isBonusId(String(BONUS_ID_MAX))).toBe(true);
    expect(isBonusId('0123456')).toBe(false);
    expect(isBonusId('123456')).toBe(false);
    expect(isBonusId('12345678')).toBe(false);
    expect(isBonusId('12a4567')).toBe(false);
  });
});

describe('the bonus address and page', () => {
  it('addresses the store and the round row apart from any day', () => {
    expect(bonusAddress('1234567')).toBe('bonus/1234567');
    expect(isBonusAddress('bonus/1234567')).toBe(true);
    expect(isBonusAddress('2026-09-24')).toBe(false);
  });

  it('is what a puzzle reference addresses: a day its date, a bonus its address', () => {
    expect(puzzleAddress({ bonusId: 1234567 })).toBe('bonus/1234567');
    expect(puzzleAddress({ dayNumber: 20638 })).toBe(dateForDayNumber(20638));
  });

  it('lives under the language like a dated day', () => {
    expect(bonusPath('fr', '1234567')).toBe('/fr/bonus/1234567');
  });

  it('names the card BONUS and its id, never a date', () => {
    expect(cardPuzzleLabel({ bonusId: 1234567 })).toBe('BONUS 1234567');
    expect(cardPuzzleLabel({ dayNumber: 20638 })).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
